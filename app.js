// ================================================================
//  app.js — FireGuard Monitoring  (FINAL v5)
//
//  PERUBAHAN DARI v4:
//  - Hapus "Deteksi hari ini" (apiCount24h) — dihapus dari HTML
//  - Hapus "Deteksi 7 hari" (apiCount7d) — dihapus dari HTML
//  - Tersisa HANYA "Terakhir terdeteksi" (apiLastTime)
//  - Firebase /stats hanya menyimpan 1 field: apiLastTime (timestamp)
//  - Tidak ada counter → tidak ada kemungkinan double-count
//  - Tidak ada reset harian → logika jauh lebih sederhana
//
//  ARSITEKTUR PERSIST:
//  ┌─────────────────────────────────────────────────────────────┐
//  │  Firebase /stats/apiLastTime = timestamp deteksi api        │
//  │  terakhir. Ditulis hanya saat api berubah 0→1.             │
//  │  Dibaca saat halaman dibuka → tidak hilang saat refresh.   │
//  └─────────────────────────────────────────────────────────────┘
//
//  ATURAN:
//  [A] apiLast DOM diupdate HANYA dari listenStats() listener
//  [B] suhuMax/Min/Avg dihitung dari history + nilai realtime
//  [C] WiFi status: timeout 30 detik dari timestamp sensor
//  [D] LoRa status: timeout 15 detik dari timestamp sensor
//
//  NODE FIREBASE:
//    /status/latest   — data sensor realtime dari ESP32
//    /history         — log 5-menit untuk grafik
//    /stats/apiLastTime — timestamp deteksi api terakhir
//    /emails          — daftar email penerima notifikasi
// ================================================================

import { initializeApp }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getDatabase, ref, onValue, query,
  orderByChild, limitToLast, push, remove, get, set, update
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
//  KONFIGURASI TIMING
// ================================================================
const SENSOR_TIMEOUT_MS        = 15000;
const WIFI_TIMEOUT_MS          = 30000;
const LORA_OFFLINE_EMAIL_MS    = 5 * 60000;
const ALERT_COOLDOWN_MS        = 5 * 60000;

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
//  STATE
// ================================================================
const state = {
  suhu:      0,
  api:       0,
  apiPrev:   -1,       // -1 = belum ada data (initial), 0 = aman, 1 = api
  loraOnline: false,
  wifiOnline: false,
  packets:    0,
  startTime:  Date.now(),

  lastFireAlert:        0,
  lastHeatAlert:        0,
  loraOfflineSince:     null,
  loraOfflineEmailSent: false,

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
  if (d > 0) return d + "h " + (h%24) + "j";
  if (h > 0) return h + "j " + (m%60) + "m";
  if (m > 0) return m + "m " + (s%60) + "d";
  return s + "d";
}
setInterval(() => {
  const up = formatUptime(Date.now() - state.startTime);
  $("footerUptime").textContent = "Uptime: " + up;
}, 1000);
setInterval(() => {
  $("headerTime").textContent = new Date().toLocaleTimeString("id-ID");
}, 1000);
$("headerTime").textContent = new Date().toLocaleTimeString("id-ID");

// ================================================================
//  DETEKSI KONEKSI WIFI VIA .info/connected
//  Otomatis berubah realtime saat WiFi putus/nyambung
// ================================================================
onValue(ref(db, ".info/connected"), snap => {
  state.wifiOnline = snap.val() === true;
  updateLedRow();
});

// ================================================================
//  CEK TIMEOUT LORA setiap 5 detik
// ================================================================
setInterval(() => {
  if (lastSensorTimestamp === null) return;
  const selisih = Date.now() - lastSensorTimestamp;

  if (selisih > SENSOR_TIMEOUT_MS && state.loraOnline) {
    state.loraOnline           = false;
    state.loraOfflineSince     = Date.now();
    state.loraOfflineEmailSent = false;
    updateLoraStatus(false);
    updateLedRow();
  }

  if (!state.loraOnline && state.loraOfflineSince) {
    const dur    = Date.now() - state.loraOfflineSince;
    const menit  = Math.floor(dur / 60000);
    const detik  = Math.floor((dur % 60000) / 1000);
    const durStr = menit > 0 ? menit + "m " + detik + "d" : detik + "d";

    $("loraSince").textContent = "Offline selama " + durStr;
    const offTxt = $("loraOfflineText");
    if (offTxt) offTxt.textContent = "Sinyal terputus " + durStr;

    if (dur >= LORA_OFFLINE_EMAIL_MS && !state.loraOfflineEmailSent) {
      state.loraOfflineEmailSent = true;
      sendEmailAlert(
        "PERINGATAN — KONEKSI LORA TERPUTUS",
        "Koneksi LoRa E220 terputus!\n\nDurasi offline: " + durStr +
        "\nWaktu: " + new Date().toLocaleString("id-ID") +
        "\n\nSegera periksa perangkat LoRa pengirim."
      );
      showToast("LoRa offline > 5 menit — email terkirim", "warn");
    }
  }
}, 5000);

// ================================================================
//  FIREBASE: STATUS/LATEST — data realtime sensor
// ================================================================
function listenLatest() {
  onValue(ref(db, "status/latest"), snap => {
    if (!snap.exists()) return;

    const d        = snap.val();
    const suhuBaru = parseFloat(d.suhu || 0);
    const apiBaru  = parseInt(d.api   || 0);

    // Simpan apiPrev sebelum update
    // apiPrev = -1 berarti ini data pertama sejak buka halaman
    const apiBerubahKeOn = (apiBaru === 1) &&
                           (state.apiPrev === 0 || state.apiPrev === -1);

    state.apiPrev = state.api;
    state.suhu    = suhuBaru;
    state.api     = apiBaru;
    state.packets++;

    lastSensorTimestamp = d.timestamp ? parseInt(d.timestamp) : Date.now();

    if (!state.loraOnline) {
      state.loraOnline           = true;
      state.loraOfflineSince     = null;
      state.loraOfflineEmailSent = false;
    }

    updateSuhuUI(state.suhu);
    updateApiUI(state.api, state.suhu);
    updateLoraStatus(true);
    updateLedRow();

    // Simpan apiLastTime ke Firebase HANYA saat api baru menyala (0→1)
    // Tidak ada counter, tidak ada debounce kompleks — tidak bisa double-count
    if (apiBerubahKeOn) {
      saveApiLastTime();
    }

    triggerAlerts(state.suhu, state.api);

    if (d.timestamp) {
      $("headerTime").textContent =
        new Date(parseInt(d.timestamp)).toLocaleTimeString("id-ID");
    }
  }, err => {
    console.warn("[Firebase] listenLatest error:", err);
  });
}

// ================================================================
//  SIMPAN apiLastTime KE FIREBASE /stats — 1 field saja
//  Tidak ada counter → tidak bisa double-count
//  Field tunggal timestamp → tidak hilang saat refresh
// ================================================================
async function saveApiLastTime() {
  try {
    await update(ref(db, "stats"), { apiLastTime: Date.now() });
  } catch (err) {
    console.warn("[Stats] Gagal simpan apiLastTime:", err);
  }
}



// ================================================================
//  LISTENER /stats/apiLastTime — hanya 1 field, tidak ada counter
//  Dipanggil saat halaman dibuka; langsung isi apiLast dari Firebase
// ================================================================
function listenStats() {
  onValue(ref(db, "stats/apiLastTime"), snap => {
    if (!snap.exists()) return;
    const ts = parseInt(snap.val());
    if (ts > 0) {
      $("apiLast").textContent = new Date(ts)
        .toLocaleString("id-ID", { dateStyle: "short", timeStyle: "short" });
    }
  });
}

// BACA apiLastTime sekali saat halaman dibuka (sebelum listener aktif)
async function loadApiLast() {
  try {
    const snap = await get(ref(db, "stats/apiLastTime"));
    if (!snap.exists()) return;
    const ts = parseInt(snap.val());
    if (ts > 0) {
      $("apiLast").textContent = new Date(ts)
        .toLocaleString("id-ID", { dateStyle: "short", timeStyle: "short" });
    }
  } catch (err) { console.warn("[Init] Gagal baca apiLastTime:", err); }
}

// ================================================================
//  FIREBASE: HISTORY (untuk grafik)
//  Setelah history load, tulis suhu stats ke Firebase sekali
//  sebagai inisialisasi jika /stats belum ada
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
          key:       child.key,
          suhu:      parseFloat(v.suhu),
          api:       parseInt(v.api || 0),
          timestamp: parseInt(v.timestamp)
        });
      }
    });

    rows.sort((a, b) => a.timestamp - b.timestamp);

    // Auto-cleanup data > 7 hari
    const cutoff7d = Date.now() - 7 * 86400000;
    rows.filter(r => r.timestamp < cutoff7d).forEach(r => {
      remove(ref(db, "history/" + r.key)).catch(() => {});
    });

    state.allHistory = rows.filter(r => r.timestamp >= cutoff7d);

    if (state.allHistory.length > 0) {
      $("chartEmpty").classList.add("hidden");

      computeSuhuStats(state.allHistory);
      renderChart(state.chartRange);
    }
  });
}

// ================================================================
//  BACA DATA TERAKHIR SAAT HALAMAN DIBUKA (survive refresh)
//  Gunakan get() bukan onValue() — baca sekali, tampil langsung
//  sebelum onValue() listenLatest mulai streaming
// ================================================================
async function loadLastData() {
  try {
    const snap = await get(ref(db, "status/latest"));
    if (!snap.exists()) return;

    const d    = snap.val();
    const suhu = parseFloat(d.suhu || 0);
    const api  = parseInt(d.api   || 0);

    // Tampilkan langsung tanpa tunggu streaming
    updateSuhuUI(suhu);
    updateApiUI(api, suhu);

    // Set state awal agar listenLatest tahu nilai sebelumnya
    state.suhu    = suhu;
    state.api     = api;
    state.apiPrev = api; // Jika sudah api=1 saat refresh, jangan tulis stats lagi

    if (d.timestamp) {
      lastSensorTimestamp = parseInt(d.timestamp);
      $("headerTime").textContent =
        new Date(lastSensorTimestamp).toLocaleTimeString("id-ID");

      const umur = Date.now() - lastSensorTimestamp;
      if (umur > SENSOR_TIMEOUT_MS) {
        state.loraOnline       = false;
        state.loraOfflineSince = Date.now() - umur;
        updateLoraStatus(false);
      } else {
        state.loraOnline = true;
        updateLoraStatus(true);
      }
    }
    updateLedRow();
    console.log("[Init] Loaded status/latest:", suhu, "°C api:", api);
  } catch (err) {
    console.warn("[Init] Gagal baca status/latest:", err);
  }
}

// ================================================================
//  UPDATE UI: SUHU (gauge)
// ================================================================
function updateSuhuUI(suhu) {
  $("gaugeVal").textContent = suhu.toFixed(1);
  const pct = Math.min(suhu / 100, 1);
  $("gaugeFill").style.strokeDasharray = (pct * 471) + " 565";

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
  const ring = $("apiRing"), label = $("apiStatusLabel");
  const sub  = $("apiSubLabel"), badge = $("apiBadge");
  const card = $("cardApi");
  const fp1  = $("flamePath"), fp2 = $("flamePath2");

  if (api === 1) {
    ring.classList.add("danger");
    label.textContent = "API TERDETEKSI!"; label.className = "api-label danger";
    sub.textContent   = "Sensor mendeteksi api aktif";
    badge.textContent = "DARURAT";         badge.className = "card-badge danger";
    card.classList.add("danger-state");
    fp1.style.opacity = "0.8"; fp2.style.opacity = "0.9";
  } else {
    ring.classList.remove("danger");
    label.textContent = "AMAN";    label.className = "api-label";
    sub.textContent   = "Tidak ada deteksi api";
    badge.textContent = "STANDBY"; badge.className = "card-badge";
    card.classList.remove("danger-state");
    fp1.style.opacity = "0.15"; fp2.style.opacity = "0.3";
  }
}

// ================================================================
//  UPDATE STATUS LORA
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
    if (offMsg) offMsg.style.display = "none";
  } else {
    txt.textContent = "OFFLINE";
    txt.className   = "lora-status-text offline";
    rings.classList.add("offline");
    if (center) center.classList.add("offline");
    if (offMsg) offMsg.style.display = "flex";
  }
}

// ================================================================
//  LED ROW
// ================================================================
function updateLedRow() {
  return;
}

// ================================================================
//  TRIGGER ALERTS (email)
// ================================================================
function triggerAlerts(suhu, api) {
  const now = Date.now();

  if (api === 1 && (now - state.lastFireAlert > ALERT_COOLDOWN_MS)) {
    state.lastFireAlert = now;
    sendEmailAlert(
      "DARURAT — API TERDETEKSI",
      "API TERDETEKSI oleh sensor LoRa!\n\nSuhu: " + suhu.toFixed(1) +
      " C\nWaktu: " + new Date().toLocaleString("id-ID") +
      "\n\nSegera periksa lokasi!"
    );
    showAlert("🔥", "API TERDETEKSI!",
      "Suhu: " + suhu.toFixed(1) + "°C · Email ke " + emailList.length + " penerima");
  }

  if (suhu > 60 && api === 0 && (now - state.lastHeatAlert > ALERT_COOLDOWN_MS)) {
    state.lastHeatAlert = now;
    sendEmailAlert(
      "PERINGATAN — SUHU TINGGI",
      "Suhu melebihi batas aman!\n\nSuhu: " + suhu.toFixed(1) +
      " C / Batas: 60 C\nWaktu: " + new Date().toLocaleString("id-ID")
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
    $("chartEmpty").classList.remove("hidden"); return;
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
      interaction: { mode:"index", intersect:false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "rgba(13,21,32,0.95)",
          borderColor: "rgba(0,255,224,0.2)", borderWidth: 1,
          titleFont: { family:"Share Tech Mono" },
          bodyFont:  { family:"Share Tech Mono" },
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
//  EMAIL MANAGEMENT
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
      '<span class="email-item-addr" title="' + item.email + '">' +
      item.email + '</span>' +
      '<button class="email-item-del" onclick="removeEmail(\'' +
      item.key + '\')" title="Hapus">\u2715</button>';
    list.appendChild(div);
  });
}

window.addEmail = async () => {
  const inp   = $("emailInput");
  const hint  = $("emailHint");
  const email = inp.value.trim().toLowerCase();

  hint.textContent = ""; hint.className = "eform-hint";
  if (!email) {
    hint.textContent = "Masukkan alamat email.";
    hint.className = "eform-hint error"; return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    hint.textContent = "Format email tidak valid.";
    hint.className = "eform-hint error"; return;
  }
  if (emailList.find(e => e.email === email)) {
    hint.textContent = "Email sudah ada.";
    hint.className = "eform-hint error"; return;
  }
  try {
    await push(ref(db, "emails"), { email });
    inp.value = "";
    hint.textContent = "Tersimpan ke database!";
    hint.className = "eform-hint success";
    showToast("Email ditambahkan: " + email, "success");
    setTimeout(() => { hint.textContent = ""; hint.className = "eform-hint"; }, 3000);
  } catch (err) {
    hint.textContent = "Gagal: " + err.message;
    hint.className = "eform-hint error";
  }
};

window.removeEmail = async key => {
  try {
    await remove(ref(db, "emails/" + key));
    showToast("Email dihapus.");
  } catch (err) {
    showToast("Gagal: " + err.message, "error");
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
  if (!emailList.length) { showToast("Tambahkan email dulu.", "error"); return; }
  if (!emailJsReady)     { showToast("EmailJS belum siap.", "warn");   return; }
  sendEmailAlert(
    "TEST — FireGuard Monitoring System",
    "Email percobaan dari FireGuard.\n\nSuhu: " + state.suhu.toFixed(1) +
    " C\nApi: "  + (state.api === 1 ? "TERDETEKSI" : "AMAN") +
    "\nLoRa: "   + (state.loraOnline ? "Online" : "Offline") +
    "\nWiFi: "   + (state.wifiOnline ? "Online" : "Offline") +
    "\nWaktu: "  + new Date().toLocaleString("id-ID")
  );
  showToast("Test email dikirim ke " + emailList.length + " penerima.", "success");
};

// ================================================================
//  INIT — urutan penting
//
//  1. listenStats()   → langsung listen /stats/apiLastTime dari Firebase
//  2. loadLastData()  → tampil suhu & api dari status/latest (no blank)
//  3. loadApiLast()   → isi apiLast sekali saat buka (sebelum stream aktif)
//  4. listenLatest()  → stream realtime, tulis ke /stats saat api 0→1
//  5. listenHistory() → grafik + suhu stats dari history
//  6. loadEmails()    → stream email penerima
// ================================================================
updateLoraStatus(false);
updateLedRow();

loadEmails();
listenStats();   // aktifkan PERTAMA — isi apiLast dari Firebase langsung

Promise.all([loadLastData(), loadApiLast()]).then(() => {
  listenLatest();
  listenHistory();
});
