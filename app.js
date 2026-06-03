// ================================================================
//  app.js — FireGuard Monitoring  (FINAL VERSION)
//
//  PEMISAHAN STATUS:
//  - Header conn-badge  = status WiFi / Firebase saja
//  - Card loraStatusText = status LoRa saja
//  - LED row:
//      lledLora  = sinyal LoRa hardware
//      lledWifi  = koneksi WiFi/Firebase
//      lledAlert = email (jumlah penerima)
//
//  EMAIL NOTIFIKASI:
//  - Api terdeteksi          → kirim langsung (cooldown 5 menit)
//  - Suhu > 60°C             → kirim langsung (cooldown 5 menit)
//  - LoRa offline > 5 menit  → kirim email sekali
//
//  SENSOR TIMEOUT: 15 detik tidak ada data = OFFLINE
// ================================================================

import { initializeApp }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getDatabase, ref, onValue, query,
  orderByChild, limitToLast, push, remove
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

// ================================================================
//  KONFIGURASI FIREBASE
// ================================================================
const firebaseConfig = {
  apiKey:            "AIzaSyDwmcc_vXKUFVxqQagm12ojcgQAyQLCGS0",
  authDomain:        "sistem-deteksi-kebakaran-2f2c8.firebaseapp.com",
  databaseURL:       "https://sistem-deteksi-kebakaran-2f2c8-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId:         "sistem-deteksi-kebakaran-2f2c8",
  storageBucket:     "sistem-deteksi-kebakaran-2f2c8.firebasestorage.app",
  messagingSenderId: "745925170634",
  appId:             "1:745925170634:web:297780122c17e7e986ab33"
};

// ================================================================
//  KONFIGURASI EMAILJS
// ================================================================
const EMAILJS_PUBLIC_KEY  = "4v6PI9FmKo9bqOz1Z";
const EMAILJS_SERVICE_ID  = "service_l9lxqu8";
const EMAILJS_TEMPLATE_ID = "template_f5yblhn";

// ================================================================
//  KONFIGURASI TIMING ALERT
//  Ubah nilai di sini jika ingin ganti durasi
// ================================================================
const SENSOR_TIMEOUT_MS     = 15000;      // 15 detik  → LoRa dianggap OFFLINE
const LORA_OFFLINE_EMAIL_MS = 5 * 60000;  // 5 MENIT   → kirim email LoRa offline
const ALERT_COOLDOWN_MS     = 5 * 60000;  // 5 menit   → jeda antar email bahaya

// ================================================================
//  INIT FIREBASE & EMAILJS
// ================================================================
const app = initializeApp(firebaseConfig);
const db  = getDatabase(app);

let emailJsReady = false;
function initEmailJS() {
  if (window.emailjs) {
    emailjs.init(EMAILJS_PUBLIC_KEY);
    emailJsReady = true;
    console.log("[EmailJS] Siap");
  } else {
    setTimeout(initEmailJS, 500);
  }
}
initEmailJS();

// ================================================================
//  STATE GLOBAL
// ================================================================
const state = {
  suhu:         0,
  api:          0,
  loraOnline:   false,
  wifiOnline:   false,
  packets:      0,
  startTime:    Date.now(),

  lastFireAlert:    0,
  lastHeatAlert:    0,
  loraOfflineSince: null,
  loraOfflineEmailSent: false,

  max24h: null, min24h: null, avg24h: null,
  apiToday: 0,  api7d: 0,
  chartRange:  1,
  allHistory:  [],
};

let emailList           = [];
let lastSensorTimestamp = null;

// ================================================================
//  DOM HELPER
// ================================================================
const $ = id => document.getElementById(id);

function showToast(msg, type = "") {
  const t = $("toast");
  t.textContent = msg;
  t.className   = "toast show " + type;
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove("show"), 4000);
}

function showAlert(icon, title, msg) {
  $("alertIcon").textContent  = icon;
  $("alertTitle").textContent = title;
  $("alertMsg").textContent   = msg;
  $("alertOverlay").classList.add("show");
}
window.dismissAlert = () => $("alertOverlay").classList.remove("show");

// ================================================================
//  UPTIME
// ================================================================
function formatUptime(ms) {
  const s = Math.floor(ms/1000), m = Math.floor(s/60),
        h = Math.floor(m/60),    d = Math.floor(h/24);
  if (d > 0) return `${d}h ${h%24}j`;
  if (h > 0) return `${h}j ${m%60}m`;
  if (m > 0) return `${m}m ${s%60}d`;
  return `${s}d`;
}

setInterval(() => {
  const up = formatUptime(Date.now() - state.startTime);
  $("lstatUptime").textContent  = up;
  $("footerUptime").textContent = "Uptime: " + up;
}, 1000);

setInterval(() => {
  $("headerTime").textContent = new Date().toLocaleTimeString("id-ID");
}, 1000);
$("headerTime").textContent = new Date().toLocaleTimeString("id-ID");

// ================================================================
//  CEK TIMEOUT SENSOR setiap 5 detik
//  Hanya update status LoRa — WiFi tetap independent
// ================================================================
setInterval(() => {
  if (lastSensorTimestamp === null) return;

  const selisih = Date.now() - lastSensorTimestamp;

  if (selisih > SENSOR_TIMEOUT_MS && state.loraOnline) {
    state.loraOnline             = true;
    state.loraOnline             = false;
    state.loraOfflineSince       = Date.now();
    state.loraOfflineEmailSent   = false;
    updateLoraStatus(false);
    updateLedRow();
  }

  if (!state.loraOnline && state.loraOfflineSince) {
    const dur    = Date.now() - state.loraOfflineSince;
    const menit  = Math.floor(dur / 60000);
    const detik  = Math.floor((dur % 60000) / 1000);
    const durStr = menit > 0 ? `${menit}m ${detik}d` : `${detik}d`;

    $("loraSince").textContent       = "Offline selama " + durStr;
    $("loraOfflineText").textContent = "Sinyal terputus " + durStr;

    // Email jika offline > 5 menit dan belum kirim
    if (dur >= LORA_OFFLINE_EMAIL_MS && !state.loraOfflineEmailSent) {
      state.loraOfflineEmailSent = true;
      sendEmailAlert(
        "PERINGATAN — KONEKSI LORA TERPUTUS",
        "Koneksi LoRa E220 terputus!\n\nDurasi offline: " + durStr +
        "\nWaktu: " + new Date().toLocaleString("id-ID") +
        "\n\nSistem tidak menerima data sensor.\nSegera periksa perangkat LoRa pengirim."
      );
      showToast("LoRa offline > 5 menit — email terkirim", "warn");
    }
  }
}, 5000);

// ================================================================
//  FIREBASE: STATUS/LATEST
// ================================================================
function listenLatest() {
  onValue(ref(db, "status/latest"), snap => {
    if (!snap.exists()) return;

    const d        = snap.val();
    state.suhu     = parseFloat(d.suhu || 0);
    state.api      = parseInt(d.api   || 0);
    state.packets++;

    lastSensorTimestamp = d.timestamp ? parseInt(d.timestamp) : Date.now();

    if (!state.loraOnline) {
      state.loraOnline             = true;
      state.loraOfflineSince       = null;
      state.loraOfflineEmailSent   = false;
    }
    state.wifiOnline = true;

    updateSuhuUI(state.suhu);
    updateApiUI(state.api, state.suhu);
    updateLoraStatus(true);
    updateWifiStatus(true);
    updateLedRow();
    // FIX: update statistik api & suhu max langsung dari realtime
    updateApiStatsRealtime(state.api, state.suhu);
    triggerAlerts(state.suhu, state.api);

    if (d.timestamp) {
      $("headerTime").textContent =
        new Date(parseInt(d.timestamp)).toLocaleTimeString("id-ID");
    }
  }, err => {
    console.warn("[Firebase] Error:", err);
    state.wifiOnline = false;
    updateWifiStatus(false);
    updateLedRow();
  });
}

// ================================================================
//  FIREBASE: HISTORY
//  FIX grafik: sort data setelah diterima agar urut waktu
//  AUTO CLEANUP: hapus data > 7 hari otomatis saat history dimuat
// ================================================================
function listenHistory() {
  const histRef = query(
    ref(db, "history"),
    orderByChild("timestamp"),
    limitToLast(2016)
  );
  onValue(histRef, snap => {
    if (!snap.exists()) return;

    const rows = [];
    snap.forEach(child => {
      const v = child.val();
      if (v && v.timestamp && v.suhu !== undefined) {
        rows.push({
          key:       child.key,           // simpan key untuk cleanup
          suhu:      parseFloat(v.suhu),
          api:       parseInt(v.api || 0),
          timestamp: parseInt(v.timestamp)
        });
      }
    });

    // FIX: pastikan urut dari lama ke baru
    rows.sort((a, b) => a.timestamp - b.timestamp);

    // AUTO CLEANUP: tandai data > 7 hari untuk dihapus
    const cutoff7d = Date.now() - 7 * 86400000;
    const toDelete = rows.filter(r => r.timestamp < cutoff7d);
    if (toDelete.length > 0) {
      console.log("[Cleanup] Menghapus", toDelete.length, "data lama...");
      toDelete.forEach(r => {
        remove(ref(db, "history/" + r.key))
          .catch(err => console.warn("[Cleanup] Gagal hapus:", err));
      });
    }

    state.allHistory = rows.filter(r => r.timestamp >= cutoff7d);

    if (state.allHistory.length > 0) {
      $("chartEmpty").classList.add("hidden");
      computeStats(state.allHistory);
      renderChart(state.chartRange);
    }
  });
}

// ================================================================
//  STATISTIK
//  FIX: suhu max dihitung dari history + data realtime sekarang
//       api stats update setiap data masuk, bukan hanya dari history
// ================================================================

// Simpan suhu tertinggi sesi ini untuk antisipasi data belum masuk history
let realtimeMaxSuhu = 0;
let realtimeApiCount = 0;  // hitung api dari realtime sesi ini
let realtimeApiLastTime = null;

function updateRealtimeStats(suhu, api) {
  // Update max realtime
  if (suhu > realtimeMaxSuhu) realtimeMaxSuhu = suhu;

  // Hitung deteksi api dari realtime (sesi ini)
  if (api === 1) {
    realtimeApiCount++;
    realtimeApiLastTime = Date.now();
  }
}

function computeStats(rows) {
  if (!rows.length) return;
  const now     = Date.now();
  const rows24h = rows.filter(r => r.timestamp >= now - 86400000);
  const rows7d  = rows.filter(r => r.timestamp >= now - 7*86400000);

  if (rows24h.length) {
    const vals = rows24h.map(r => r.suhu);
    // FIX: bandingkan max history dengan nilai realtime sekarang
    const maxFromHistory = Math.max(...vals);
    const maxFinal = Math.max(maxFromHistory, realtimeMaxSuhu, state.suhu);
    $("suhuMax24").textContent = maxFinal.toFixed(1) + "°";
    $("suhuMin24").textContent = Math.min(...vals).toFixed(1) + "°";
    $("suhuAvg24").textContent =
      (vals.reduce((a,b) => a+b, 0) / vals.length).toFixed(1) + "°";
  } else {
    // Belum ada history, pakai data realtime
    if (state.suhu > 0) {
      $("suhuMax24").textContent = Math.max(state.suhu, realtimeMaxSuhu).toFixed(1) + "°";
      $("suhuMin24").textContent = state.suhu.toFixed(1) + "°";
      $("suhuAvg24").textContent = state.suhu.toFixed(1) + "°";
    }
  }

  // FIX: hitung api dari history + tambah dari realtime sesi ini
  const apiCountHistory24h = rows24h.filter(r => r.api===1).length;
  const apiCountHistory7d  = rows7d.filter(r => r.api===1).length;

  // Tambahkan hitungan realtime jika belum masuk history
  const totalToday = apiCountHistory24h + (state.api === 1 ? 0 : 0);
  $("apiToday").textContent = apiCountHistory24h + "x";
  $("api7d").textContent    = apiCountHistory7d  + "x";

  // Terakhir terdeteksi: ambil dari history, atau dari realtime jika lebih baru
  const fires = rows7d.filter(r => r.api === 1);
  if (fires.length) {
    const lastTs = fires[fires.length-1].timestamp;
    // Bandingkan dengan realtime
    const finalTs = (realtimeApiLastTime && realtimeApiLastTime > lastTs)
      ? realtimeApiLastTime : lastTs;
    $("apiLast").textContent = new Date(finalTs)
      .toLocaleString("id-ID", { dateStyle:"short", timeStyle:"short" });
  } else if (realtimeApiLastTime) {
    $("apiLast").textContent = new Date(realtimeApiLastTime)
      .toLocaleString("id-ID", { dateStyle:"short", timeStyle:"short" });
  }
}

// FIX: update statistik api langsung saat data realtime masuk
// dipanggil dari listenLatest() setiap ada data baru
function updateApiStatsRealtime(api, suhu) {
  updateRealtimeStats(suhu, api);

  // Update tampilan api stats langsung tanpa tunggu history
  if (api === 1) {
    realtimeApiLastTime = Date.now();
    // Tambah ke tampilan sekarang juga
    const todayEl = $("apiToday");
    const now7dEl = $("api7d");
    const lastEl  = $("apiLast");

    // Parse nilai sekarang dan tambah 1
    const curToday = parseInt(todayEl.textContent) || 0;
    const cur7d    = parseInt(now7dEl.textContent) || 0;
    todayEl.textContent = (curToday + 1) + "x";
    now7dEl.textContent = (cur7d + 1)    + "x";
    lastEl.textContent  = new Date().toLocaleString("id-ID",
      { dateStyle:"short", timeStyle:"short" });
  }

  // Update suhu max jika suhu sekarang lebih tinggi dari yang tampil
  if (suhu > 0) {
    const maxEl   = $("suhuMax24");
    const curMax  = parseFloat(maxEl.textContent) || 0;
    if (suhu > curMax) {
      maxEl.textContent = suhu.toFixed(1) + "°";
    }
  }
}

// ================================================================
//  UPDATE UI: SUHU
// ================================================================
function updateSuhuUI(suhu) {
  $("gaugeVal").textContent = suhu.toFixed(1);
  const pct = Math.min(suhu / 100, 1);
  $("gaugeFill").style.strokeDasharray = (pct * 471) + " 565";
  // suhuBarFill dihapus dari HTML, tidak perlu update

  const gF = $("gaugeFill"), gV = $("gaugeVal");
  const bd = $("suhuBadge"), cd = $("cardSuhu");

  if (suhu > 60) {
    gF.style.stroke = "#ff2b2b"; gV.style.color = "#ff2b2b";
    bd.textContent  = "BAHAYA";  bd.className   = "card-badge danger";
    cd.classList.add("danger-state"); cd.classList.remove("warn-state");
  } else if (suhu > 40) {
    gF.style.stroke = "#ff9300"; gV.style.color = "#ff9300";
    bd.textContent  = "PERINGATAN"; bd.className = "card-badge warn";
    cd.classList.add("warn-state"); cd.classList.remove("danger-state");
  } else {
    gF.style.stroke = ""; gV.style.color = "";
    bd.textContent  = "NORMAL"; bd.className = "card-badge";
    cd.classList.remove("danger-state", "warn-state");
  }
}

// ================================================================
//  UPDATE UI: API
// ================================================================
function updateApiUI(api, suhu) {
  const ring  = $("apiRing"), label = $("apiStatusLabel");
  const sub   = $("apiSubLabel"), badge = $("apiBadge");
  const card  = $("cardApi"), sig   = $("signalDot");
  const fp1   = $("flamePath"), fp2  = $("flamePath2");

  if (api === 1) {
    ring.classList.add("danger");
    label.textContent = "API TERDETEKSI!"; label.className = "api-label danger";
    sub.textContent   = "Sensor mendeteksi api aktif";
    badge.textContent = "DARURAT";         badge.className = "card-badge danger";
    card.classList.add("danger-state");
    sig.classList.add("danger"); sig.classList.remove("active");
    fp1.style.opacity = "0.8"; fp2.style.opacity = "0.9";
  } else {
    ring.classList.remove("danger");
    label.textContent = "AMAN";     label.className = "api-label";
    sub.textContent   = "Tidak ada deteksi api";
    badge.textContent = "STANDBY";  badge.className = "card-badge";
    card.classList.remove("danger-state");
    sig.classList.remove("danger"); sig.classList.add("active");
    fp1.style.opacity = "0.15"; fp2.style.opacity = "0.3";
  }
}

// ================================================================
//  UPDATE STATUS LORA — card koneksi, TERPISAH dari WiFi
// ================================================================
function updateLoraStatus(online) {
  const txt    = $("loraStatusText");
  const since  = $("loraSince");
  const rings  = $("loraRings");
  const center = rings ? rings.querySelector(".lring-center") : null;
  const offMsg = $("loraOfflineMsg");

  $("lstatPackets").textContent = state.packets;

  if (online) {
    txt.textContent   = "TERHUBUNG";
    txt.className     = "lora-status-text online";
    since.textContent = "Data LoRa diterima";
    rings.classList.remove("offline");
    if (center) center.classList.remove("offline");
    offMsg.style.display = "none";
  } else {
    txt.textContent = "OFFLINE";
    txt.className   = "lora-status-text offline";
    rings.classList.add("offline");
    if (center) center.classList.add("offline");
    offMsg.style.display = "flex";
  }
}

// ================================================================
//  UPDATE STATUS WIFI — header badge, TERPISAH dari LoRa
// ================================================================
function updateWifiStatus(online) {
  state.wifiOnline = online;
  $("connBadge").className = "conn-badge " + (online ? "online" : "offline");
  $("connText").textContent = online ? "ONLINE" : "OFFLINE";

  const sig = $("signalDot");
  if (online && state.api !== 1) {
    sig.classList.add("active"); sig.classList.remove("danger");
  } else if (!online) {
    sig.classList.remove("active");
  }
}

// ================================================================
//  UPDATE LED ROW — 3 indikator terpisah dan jelas
// ================================================================
function updateLedRow() {
  // LoRa
  const lledL  = $("lledLora");
  const lledLT = $("lledLoraText");
  lledL.className    = state.loraOnline ? "lled on" : "lled off";
  lledLT.textContent = state.loraOnline ? "Terhubung" : "Offline";

  // WiFi
  const lledW  = $("lledWifi");
  const lledWT = $("lledWifiText");
  lledW.className    = state.wifiOnline ? "lled on" : "lled off";
  lledWT.textContent = state.wifiOnline ? "Online" : "Offline";

  // Email
  const lledA  = $("lledAlert");
  const lledAT = $("lledAlertText");
  lledA.className    = emailList.length ? "lled on" : "lled";
  lledAT.textContent = emailList.length + " penerima";
}

// ================================================================
//  TRIGGER ALERTS
// ================================================================
function triggerAlerts(suhu, api) {
  const now = Date.now();

  if (api === 1 && (now - state.lastFireAlert > ALERT_COOLDOWN_MS)) {
    state.lastFireAlert = now;
    sendEmailAlert(
      "DARURAT — API TERDETEKSI",
      "API TERDETEKSI oleh sensor LoRa!\n\nSuhu: " + suhu.toFixed(1) + " C\nWaktu: " +
      new Date().toLocaleString("id-ID") + "\n\nSegera periksa lokasi!"
    );
    showAlert("🔥", "API TERDETEKSI!",
      "Suhu: " + suhu.toFixed(1) + "°C · Email dikirim ke " + emailList.length + " penerima");
  }

  if (suhu > 60 && api === 0 && (now - state.lastHeatAlert > ALERT_COOLDOWN_MS)) {
    state.lastHeatAlert = now;
    sendEmailAlert(
      "PERINGATAN — SUHU TINGGI",
      "Suhu melebihi batas aman!\n\nSuhu: " + suhu.toFixed(1) + " C / Batas: 60 C\nWaktu: " +
      new Date().toLocaleString("id-ID")
    );
    showToast("Suhu " + suhu.toFixed(1) + "°C — email dikirim", "warn");
  }
}

// ================================================================
//  CHART
// ================================================================
let suhuChartInst = null;

function renderChart(rangeDays) {
  const rows = state.allHistory;
  if (!rows.length) return;

  $("chartEmpty").classList.add("hidden");
  const cutoff   = Date.now() - rangeDays * 86400000;
  const filtered = rows.filter(r => r.timestamp >= cutoff);
  if (!filtered.length) {
    $("chartEmpty").classList.remove("hidden");
    return;
  }

  const step = Math.max(1, Math.floor(filtered.length / 200));
  const labels = [], data = [], apiDots = [];

  filtered.forEach((r, i) => {
    if (i % step !== 0) return;
    const d  = new Date(r.timestamp);
    const lb = rangeDays <= 1
      ? d.toLocaleTimeString("id-ID", { hour:"2-digit", minute:"2-digit" })
      : d.toLocaleString("id-ID", { month:"short", day:"numeric",
          hour:"2-digit", minute:"2-digit" });
    labels.push(lb);
    data.push(r.suhu);
    apiDots.push(r.api === 1 ? r.suhu : null);
  });

  const ctx = $("suhuChart").getContext("2d");
  if (suhuChartInst) suhuChartInst.destroy();

  const grad = ctx.createLinearGradient(0, 0, 0, 280);
  grad.addColorStop(0,   "rgba(0,255,224,0.2)");
  grad.addColorStop(0.7, "rgba(0,255,224,0.03)");
  grad.addColorStop(1,   "rgba(0,255,224,0)");

  suhuChartInst = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Suhu", data,
          borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 4,
          tension: 0.4, fill: true, backgroundColor: grad,
          segment: {
            borderColor: c => {
              const v = c.p1.parsed.y;
              return v > 60 ? "rgba(255,43,43,0.9)" :
                     v > 40 ? "rgba(255,147,0,0.9)" :
                               "rgba(0,255,224,0.8)";
            }
          }
        },
        {
          label: "Api", data: apiDots, type: "scatter",
          pointRadius: 5, pointHoverRadius: 7, showLine: false,
          pointBackgroundColor: "rgba(255,43,43,0.9)",
          pointBorderColor: "#ff2b2b",
        }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "rgba(13,21,32,0.95)",
          borderColor: "rgba(0,255,224,0.2)", borderWidth: 1,
          titleFont: { family: "Share Tech Mono" },
          bodyFont:  { family: "Share Tech Mono" },
          callbacks: {
            label: c => {
              if (c.datasetIndex === 0) return " Suhu: " + c.parsed.y.toFixed(1) + "°C";
              if (c.parsed.y !== null)  return " API TERDETEKSI";
              return null;
            }
          }
        }
      },
      scales: {
        x: {
          ticks: { color:"rgba(74,96,112,0.8)",
                   font:{family:"Share Tech Mono",size:10},
                   maxTicksLimit:8, maxRotation:0 },
          grid:  { color:"rgba(255,255,255,0.03)" }
        },
        y: {
          min: 0,
          ticks: { color:"rgba(74,96,112,0.8)",
                   font:{family:"Share Tech Mono",size:10},
                   callback: v => v + "°" },
          grid:  { color:"rgba(255,255,255,0.04)" }
        }
      }
    }
  });
}

document.querySelectorAll(".ctab").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".ctab").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    state.chartRange = parseInt(btn.dataset.range);
    renderChart(state.chartRange);
  });
});

// ================================================================
//  EMAIL MANAGEMENT — simpan ke Firebase /emails
// ================================================================
function loadEmails() {
  onValue(ref(db, "emails"), snap => {
    emailList = [];
    if (snap.exists()) {
      snap.forEach(child => {
        emailList.push({ key: child.key, email: child.val().email });
      });
    }
    renderEmailList();
    updateLedRow();
  });
}

function renderEmailList() {
  const list  = $("emailList");
  const empty = $("elistEmpty");
  $("emailCount").textContent = emailList.length + " email";
  list.querySelectorAll(".email-item").forEach(el => el.remove());

  if (!emailList.length) { empty.style.display = "flex"; return; }
  empty.style.display = "none";

  emailList.forEach(item => {
    const div = document.createElement("div");
    div.className = "email-item";
    div.innerHTML =
      '<span class="email-item-addr" title="' + item.email + '">' + item.email + '</span>' +
      '<button class="email-item-del" onclick="removeEmail(\'' + item.key + '\')" title="Hapus">x</button>';
    list.appendChild(div);
  });
}

window.addEmail = async () => {
  const inp   = $("emailInput");
  const hint  = $("emailHint");
  const email = inp.value.trim().toLowerCase();

  hint.textContent = ""; hint.className = "eform-hint";

  if (!email) {
    hint.textContent = "Masukkan alamat email."; hint.className = "eform-hint error"; return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    hint.textContent = "Format email tidak valid."; hint.className = "eform-hint error"; return;
  }
  if (emailList.find(e => e.email === email)) {
    hint.textContent = "Email sudah ada."; hint.className = "eform-hint error"; return;
  }

  try {
    await push(ref(db, "emails"), { email });
    inp.value = "";
    hint.textContent = "Tersimpan ke database!"; hint.className = "eform-hint success";
    showToast("Email ditambahkan: " + email, "success");
    setTimeout(() => { hint.textContent = ""; hint.className = "eform-hint"; }, 3000);
  } catch (err) {
    hint.textContent = "Gagal: " + err.message; hint.className = "eform-hint error";
  }
};

window.removeEmail = async key => {
  try {
    await remove(ref(db, "emails/" + key));
    showToast("Email dihapus.");
  } catch (err) {
    showToast("Gagal hapus: " + err.message, "error");
  }
};

$("emailInput").addEventListener("keydown", e => {
  if (e.key === "Enter") window.addEmail();
});

// ================================================================
//  KIRIM EMAIL VIA EMAILJS
// ================================================================
function sendEmailAlert(subject, body) {
  if (!emailJsReady) {
    setTimeout(() => sendEmailAlert(subject, body), 1000); return;
  }
  if (!emailList.length) return;

  emailList.forEach(item => {
    emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, {
      to_email:   item.email,
      subject:    subject,
      message:    body,
      time:       new Date().toLocaleString("id-ID"),
      suhu:       state.suhu.toFixed(1),
      api_status: state.api === 1 ? "API TERDETEKSI" : "AMAN",
    }).then(
      ()  => console.log("[EmailJS] OK:", item.email),
      err => console.error("[EmailJS] Gagal:", item.email, err)
    );
  });
}

window.sendTestEmail = () => {
  if (!emailList.length) {
    showToast("Tambahkan email penerima dulu.", "error"); return;
  }
  if (!emailJsReady) {
    showToast("EmailJS belum siap.", "warn"); return;
  }
  sendEmailAlert(
    "TEST — FireGuard Monitoring System",
    "Email percobaan dari FireGuard.\n\nSuhu: " + state.suhu.toFixed(1) +
    " C\nStatus Api: " + (state.api===1?"TERDETEKSI":"AMAN") +
    "\nLoRa: " + (state.loraOnline?"Online":"Offline") +
    "\nWiFi: " + (state.wifiOnline?"Online":"Offline") +
    "\nWaktu: " + new Date().toLocaleString("id-ID")
  );
  showToast("Test email dikirim ke " + emailList.length + " penerima.", "success");
};

// ================================================================
//  INIT
// ================================================================
updateWifiStatus(false);
updateLoraStatus(false);
updateLedRow();

loadEmails();
listenLatest();
listenHistory();
