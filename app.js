// ================================================================
//  app.js — FireGuard Monitoring  (NO EMAILJS)
//  Firebase Realtime Database
//
//  FITUR:
//  - Data survive refresh (suhu, api, terakhir terdeteksi)
//  - WiFi/LoRa status berdasarkan timestamp data ESP32
//  - Min/Max/Avg suhu dari history + realtime
//  - Terakhir terdeteksi disimpan ke /stats Firebase
//  - Auto-cleanup history >7 hari
//  - Tambah/hapus email penerima (untuk dibaca Google Apps Script)
//
//  CATATAN:
//  - Email notifikasi (api terdeteksi, suhu >60C, LoRa offline)
//    SUDAH DIPINDAH ke Google Apps Script yang jalan di server
//    Google tiap 1 menit, supaya tetap terkirim walau web ditutup.
//  - app.js ini HANYA untuk dashboard (tampilan) dan kelola daftar
//    email (/emails), TIDAK lagi mengirim email sendiri.
// ================================================================

import { initializeApp }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getDatabase, ref, onValue, query,
  orderByChild, limitToLast, push, remove, get, update
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
//  KONFIGURASI TIMING
// ================================================================
const SENSOR_TIMEOUT_MS = 15000;  // 15 detik → LoRa OFFLINE
const WIFI_TIMEOUT_MS   = 30000;  // 30 detik → WiFi ESP32 OFFLINE

// ================================================================
//  INIT FIREBASE
// ================================================================
const app = initializeApp(firebaseConfig);
const db  = getDatabase(app);

// ================================================================
//  STATE GLOBAL
// ================================================================
const state = {
  suhu:      0,
  api:       0,
  apiPrev:   0,
  loraOnline: false,
  wifiOnline: false,
  packets:    0,
  startTime:  Date.now(),

  loraOfflineSince: null,

  chartRange:  1,
  allHistory:  [],
};

let emailList           = [];
let lastSensorTimestamp = null;
let cachedSuhu          = 0;
let cachedApi           = 0;

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
  $("lstatUptime").textContent  = up;
  $("footerUptime").textContent = "Uptime: " + up;
}, 1000);

setInterval(() => {
  $("headerTime").textContent = new Date().toLocaleTimeString("id-ID");
}, 1000);
$("headerTime").textContent = new Date().toLocaleTimeString("id-ID");

// ================================================================
//  DETEKSI STATUS WIFI & LORA — dari timestamp data ESP32
// ================================================================
function setWifiStatus(connected) {
  if (state.wifiOnline === connected) return;
  state.wifiOnline = connected;
  updateLedRow();
}

setInterval(() => {
  if (lastSensorTimestamp === null) return;
  const selisih = Date.now() - lastSensorTimestamp;

  if (selisih > SENSOR_TIMEOUT_MS && state.loraOnline) {
    state.loraOnline       = false;
    state.loraOfflineSince = Date.now();
    updateLoraStatus(false, "lora");
    updateLedRow();
  }

  if (selisih > WIFI_TIMEOUT_MS && state.wifiOnline)   setWifiStatus(false);
  if (selisih <= WIFI_TIMEOUT_MS && !state.wifiOnline)  setWifiStatus(true);

  if (!state.loraOnline && state.loraOfflineSince) {
    const dur    = Date.now() - state.loraOfflineSince;
    const menit  = Math.floor(dur / 60000);
    const detik  = Math.floor((dur % 60000) / 1000);
    const durStr = menit > 0 ? menit + "m " + detik + "d" : detik + "d";
  }
}, 5000);

// ================================================================
//  BACA DATA TERAKHIR SAAT HALAMAN DIBUKA (survive refresh)
// ================================================================
async function loadLastData() {
  try {
    const snap = await get(ref(db, "status/latest"));
    if (!snap.exists()) return;
    const d    = snap.val();
    cachedSuhu = parseFloat(d.suhu || 0);
    cachedApi  = parseInt(d.api   || 0);

    updateSuhuUI(cachedSuhu);
    updateApiUI(cachedApi, cachedSuhu);

    if (cachedSuhu > 0) {
      $("suhuMax24").textContent = cachedSuhu.toFixed(1) + "°";
      $("suhuMin24").textContent = cachedSuhu.toFixed(1) + "°";
      $("suhuAvg24").textContent = cachedSuhu.toFixed(1) + "°";
    }

    if (d.timestamp) {
      lastSensorTimestamp = parseInt(d.timestamp);
      $("headerTime").textContent =
        new Date(lastSensorTimestamp).toLocaleTimeString("id-ID");

      const umur = Date.now() - lastSensorTimestamp;
      if (umur > SENSOR_TIMEOUT_MS) {
        state.loraOnline       = false;
        state.loraOfflineSince = lastSensorTimestamp;
        updateLoraStatus(false, "lora");
      } else {
        state.loraOnline = true;
        updateLoraStatus(true);
      }
    }
  } catch (err) {
    console.warn("[Init] Gagal baca status/latest:", err);
  }
}

// ================================================================
//  BACA & DENGARKAN /stats — hanya apiLastTime
// ================================================================
async function loadApiStats() {
  try {
    const snap = await get(ref(db, "stats"));
    if (!snap.exists()) return;
    const s = snap.val();
    if (s.apiLastTime && s.apiLastTime > 0) {
      $("apiLast").textContent = new Date(parseInt(s.apiLastTime))
        .toLocaleString("id-ID", { dateStyle: "short", timeStyle: "short" });
    }
  } catch (err) {
    console.warn("[Init] Gagal baca stats:", err);
  }
}

function listenStats() {
  onValue(ref(db, "stats"), snap => {
    if (!snap.exists()) return;
    const s = snap.val();
    if (s.apiLastTime && s.apiLastTime > 0) {
      $("apiLast").textContent = new Date(parseInt(s.apiLastTime))
        .toLocaleString("id-ID", { dateStyle: "short", timeStyle: "short" });
    }
  });
}

async function saveApiLastTime() {
  try {
    await update(ref(db, "stats"), { apiLastTime: Date.now() });
  } catch (err) {
    console.warn("[Stats] Gagal simpan:", err);
  }
}

// ================================================================
//  FIREBASE: LISTEN STATUS/LATEST (realtime)
// ================================================================
function listenLatest() {
  onValue(ref(db, "status/latest"), snap => {
    if (!snap.exists()) return;

    const d        = snap.val();
    state.apiPrev  = state.api;
    state.suhu     = parseFloat(d.suhu || 0);
    state.api      = parseInt(d.api   || 0);
    state.packets++;

    lastSensorTimestamp = d.timestamp ? parseInt(d.timestamp) : Date.now();

    if (!state.loraOnline) {
      state.loraOnline       = true;
      state.loraOfflineSince = null;
    }
    setWifiStatus(true);

    updateSuhuUI(state.suhu);
    updateApiUI(state.api, state.suhu);
    updateLoraStatus(true);
    updateLedRow();

    if (state.api === 1 && state.apiPrev === 0) {
      saveApiLastTime();
      const now = new Date();
      $("apiLast").textContent = now.toLocaleString("id-ID",
        { dateStyle: "short", timeStyle: "short" });

      // Tampilkan alert visual di dashboard (jika sedang dibuka)
      // Email peringatan ditangani oleh Google Apps Script di server
      showAlert("🔥", "API TERDETEKSI!", "Suhu: " + state.suhu.toFixed(1) + "°C");
    }

    updateSuhuStatsRealtime(state.suhu);

    if (d.timestamp) {
      $("headerTime").textContent =
        new Date(parseInt(d.timestamp)).toLocaleTimeString("id-ID");
    }
  }, err => {
    console.warn("[Firebase] onValue error:", err);
  });
}

// ================================================================
//  FIREBASE: HISTORY
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

    const cutoff7d = Date.now() - 7 * 86400000;
    rows.filter(r => r.timestamp < cutoff7d).forEach(r => {
      remove(ref(db, "history/" + r.key)).catch(() => {});
    });

    state.allHistory = rows.filter(r => r.timestamp >= cutoff7d);

    if (state.allHistory.length > 0) {
      $("chartEmpty").classList.add("hidden");
      computeStats(state.allHistory);
      renderChart(state.chartRange);
    }
  });
}

// ================================================================
//  STATISTIK SUHU dari history + realtime
// ================================================================
function computeStats(rows) {
  if (!rows.length) return;

  const now     = Date.now();
  const cut24h  = now - 86400000;
  const rows24h = rows.filter(r => r.timestamp >= cut24h);

  const suhuAktif = state.suhu > 0 ? state.suhu : cachedSuhu;

  if (rows24h.length) {
    const vals = rows24h.map(r => r.suhu);
    if (suhuAktif > 0) vals.push(suhuAktif);

    $("suhuMax24").textContent = Math.max(...vals).toFixed(1) + "°";
    $("suhuMin24").textContent = Math.min(...vals).toFixed(1) + "°";
    $("suhuAvg24").textContent =
      (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1) + "°";

  } else if (suhuAktif > 0) {
    $("suhuMax24").textContent = suhuAktif.toFixed(1) + "°";
    $("suhuMin24").textContent = suhuAktif.toFixed(1) + "°";
    $("suhuAvg24").textContent = suhuAktif.toFixed(1) + "°";
  }

  const curLast = $("apiLast").textContent;
  if (curLast === "—" || curLast === "--") {
    const fires = rows.filter(r => r.api === 1);
    if (fires.length) {
      $("apiLast").textContent = new Date(fires[fires.length - 1].timestamp)
        .toLocaleString("id-ID", { dateStyle: "short", timeStyle: "short" });
    }
  }
}

// ================================================================
//  UPDATE MIN/MAX/AVG DARI DATA REALTIME
// ================================================================
function updateSuhuStatsRealtime(suhu) {
  if (suhu <= 0) return;

  const maxEl  = $("suhuMax24");
  const minEl  = $("suhuMin24");
  const avgEl  = $("suhuAvg24");

  const curMax = parseFloat(maxEl.textContent);
  const curMin = parseFloat(minEl.textContent);

  if (isNaN(curMax) || suhu > curMax)
    maxEl.textContent = suhu.toFixed(1) + "°";

  if (isNaN(curMin) || suhu < curMin)
    minEl.textContent = suhu.toFixed(1) + "°";

  if (!state.allHistory.length)
    avgEl.textContent = suhu.toFixed(1) + "°";
}

// ================================================================
//  UPDATE UI: SUHU
// ================================================================
function updateSuhuUI(suhu) {
  $("gaugeVal").textContent = suhu.toFixed(1);
  const pct = Math.min(suhu / 100, 1);
  $("gaugeFill").style.strokeDasharray = (pct * 471) + " 565";

  const gF = $("gaugeFill"), gV = $("gaugeVal");
  const bd = $("suhuBadge"),  cd = $("cardSuhu");

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
function updateLoraStatus(online, sebab) {
  const txt    = $("loraStatusText");
  const since  = $("loraSince");
  const rings  = $("loraRings");
  const center = rings ? rings.querySelector(".lring-center") : null;

  $("lstatPackets").textContent = state.packets;

  if (online) {
    txt.textContent   = "TERHUBUNG";
    txt.className     = "lora-status-text online";
    since.textContent = "Data LoRa diterima";
    rings.classList.remove("offline");
    if (center) center.classList.remove("offline");
  } else {
    txt.textContent = "OFFLINE";
    txt.className   = "lora-status-text offline";
    rings.classList.add("offline");
    if (center) center.classList.add("offline");
    since.textContent = sebab === "wifi" ? "WiFi terputus" : "Sinyal LoRa tidak ada";
  }
}

// ================================================================
//  LED ROW
// ================================================================
function updateLedRow() {
  const lledL  = $("lledLora"),  lledLT = $("lledLoraText");
  const lledW  = $("lledWifi"),  lledWT = $("lledWifiText");
  const lledA  = $("lledAlert"), lledAT = $("lledAlertText");

  if (lledL && lledLT) {
    lledL.className    = state.loraOnline  ? "lled on"  : "lled off";
    lledLT.textContent = state.loraOnline  ? "Terhubung" : "Offline";
  }
  if (lledW && lledWT) {
    lledW.className    = state.wifiOnline  ? "lled on"  : "lled off";
    lledWT.textContent = state.wifiOnline  ? "Online"   : "Offline";
  }
  if (lledA && lledAT) {
    lledA.className    = emailList.length  ? "lled on"  : "lled";
    lledAT.textContent = emailList.length  + " penerima";
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
  if (!filtered.length) { $("chartEmpty").classList.remove("hidden"); return; }

  const step = Math.max(1, Math.floor(filtered.length / 200));
  const labels = [], data = [], apiDots = [];

  filtered.forEach((r, i) => {
    if (i % step !== 0) return;
    const d  = new Date(r.timestamp);
    const lb = rangeDays <= 1
      ? d.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" })
      : d.toLocaleString("id-ID", { month: "short", day: "numeric",
          hour: "2-digit", minute: "2-digit" });
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
          ticks: { color: "rgba(74,96,112,0.8)",
                   font: { family: "Share Tech Mono", size: 10 },
                   maxTicksLimit: 8, maxRotation: 0 },
          grid:  { color: "rgba(255,255,255,0.03)" }
        },
        y: {
          min: 0,
          ticks: { color: "rgba(74,96,112,0.8)",
                   font: { family: "Share Tech Mono", size: 10 },
                   callback: v => v + "°" },
          grid:  { color: "rgba(255,255,255,0.04)" }
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
//  EMAIL MANAGEMENT — tersimpan di Firebase /emails
//  Daftar ini dibaca oleh Google Apps Script untuk kirim notifikasi
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
      item.key + '\')" title="Hapus">✕</button>';
    list.appendChild(div);
  });
}

// Verifikasi admin sebelum tambah/hapus email
const ADMIN_PASSWORD = "12345";

window.addEmail = async () => {
  const password = prompt("Masukkan password admin");
  if (password === null) return;

  if (password !== ADMIN_PASSWORD) {
    alert("Password salah!");
    return;
  }

  const inp   = $("emailInput");
  const hint  = $("emailHint");
  const email = inp.value.trim().toLowerCase();

  hint.textContent = "";
  hint.className = "eform-hint";

  if (!email) {
    hint.textContent = "Masukkan alamat email.";
    hint.className = "eform-hint error";
    return;
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    hint.textContent = "Format email tidak valid.";
    hint.className = "eform-hint error";
    return;
  }

  if (emailList.find(e => e.email === email)) {
    hint.textContent = "Email sudah ada.";
    hint.className = "eform-hint error";
    return;
  }

  try {
    await push(ref(db, "emails"), { email });
    inp.value = "";

    hint.textContent = "Tersimpan ke database!";
    hint.className = "eform-hint success";

    showToast("Email ditambahkan: " + email, "success");

    setTimeout(() => {
      hint.textContent = "";
      hint.className = "eform-hint";
    }, 3000);

  } catch (err) {
    console.error(err);
    hint.textContent = "Gagal menyimpan email.";
    hint.className = "eform-hint error";
  }
};

window.removeEmail = async key => {
  const password = prompt("Masukkan password admin");
  if (password === null) return;

  if (password !== ADMIN_PASSWORD) {
    alert("Password salah!");
    return;
  }

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
//  INIT
// ================================================================
updateLoraStatus(false, "lora");
state.wifiOnline = false;
updateLedRow();

Promise.all([loadLastData(), loadApiStats()]).then(() => {
  listenLatest();
  listenHistory();
  listenStats();
});

loadEmails();
