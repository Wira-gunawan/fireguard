// ================================================================
//  app.js — FireGuard Monitoring
//  Firebase Realtime Database + EmailJS
//
//  ISI KONFIGURASI DI BAWAH SEBELUM DEPLOY
// ================================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getDatabase, ref, onValue, query,
  orderByChild, limitToLast, startAt
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

// ================================================================
//  ★ GANTI DENGAN CONFIG FIREBASE PROJECT ANDA ★
// ================================================================
const firebaseConfig = {
  apiKey: "AIzaSyDwmcc_vXKUFVxqQagm12ojcgQAyQLCGS0",
  authDomain: "sistem-deteksi-kebakaran-2f2c8.firebaseapp.com",
  databaseURL: "https://sistem-deteksi-kebakaran-2f2c8-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "sistem-deteksi-kebakaran-2f2c8",
  storageBucket: "sistem-deteksi-kebakaran-2f2c8.firebasestorage.app",
  messagingSenderId: "745925170634",
  appId: "1:745925170634:web:297780122c17e7e986ab33"
};

// ================================================================
//  ★ GANTI DENGAN KONFIGURASI EMAILJS ANDA ★
//    Daftar di https://emailjs.com (gratis 200 email/bulan)
// ================================================================
const EMAILJS_PUBLIC_KEY  = "4v6PI9FmKo9bqOz1Z";
const EMAILJS_SERVICE_ID  = "service_l9lxqu8";      // e.g. "service_abc123"
const EMAILJS_TEMPLATE_ID = "template_f5yblhn";     // e.g. "template_xyz789"

// ================================================================
//  INISIALISASI FIREBASE
// ================================================================
const app = initializeApp(firebaseConfig);
const db  = getDatabase(app);

// ================================================================
//  INISIALISASI EMAILJS
// ================================================================
if (window.emailjs) {
  emailjs.init(EMAILJS_PUBLIC_KEY);
}

// ================================================================
//  STATE GLOBAL
// ================================================================
const state = {
  suhu:         0,
  api:          0,
  loraOnline:   false,
  firebaseOk:   false,
  packets:      0,
  startTime:    Date.now(),

  // alert cooldown (5 menit per tipe)
  lastFireAlert: 0,
  lastHeatAlert: 0,
  COOLDOWN: 5 * 60 * 1000,

  // statistik
  max24h: null,
  min24h: null,
  avg24h: null,
  apiToday: 0,
  api7d: 0,
  apiLastTime: null,

  // range chart aktif (hari)
  chartRange: 1,
  allHistory: [],
};

// Daftar email: disimpan di localStorage
let emailList = JSON.parse(localStorage.getItem("fg_emails") || "[]");

// ================================================================
//  DOM HELPERS
// ================================================================
const $  = id => document.getElementById(id);
const el = selector => document.querySelector(selector);

function setTicker(msg, danger = false) {
  $("tickerMsg").textContent = msg;
  $("tickerBar").classList.toggle("danger", danger);
}

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
//  UPTIME TICKER
// ================================================================
function formatUptime(ms) {
  const s  = Math.floor(ms / 1000);
  const m  = Math.floor(s / 60);
  const h  = Math.floor(m / 60);
  const d  = Math.floor(h / 24);
  if (d > 0)  return `${d}h ${h % 24}j`;
  if (h > 0)  return `${h}j ${m % 60}m`;
  if (m > 0)  return `${m}m ${s % 60}d`;
  return `${s}d`;
}

setInterval(() => {
  const up = formatUptime(Date.now() - state.startTime);
  $("lstatUptime").textContent = up;
  $("footerUptime").textContent = "Uptime: " + up;
}, 1000);

// ================================================================
//  WAKTU HEADER
// ================================================================
function updateHeaderTime() {
  $("headerTime").textContent = new Date().toLocaleTimeString("id-ID");
}
setInterval(updateHeaderTime, 1000);
updateHeaderTime();

// ================================================================
//  FIREBASE: LISTEN STATUS/LATEST
// ================================================================
function listenLatest() {
  const latestRef = ref(db, "status/latest");
  onValue(latestRef, snap => {
    if (!snap.exists()) return;

    const d = snap.val();
    state.suhu      = parseFloat(d.suhu || 0);
    state.api       = parseInt(d.api   || 0);
    state.loraOnline = true;
    state.firebaseOk = true;
    state.packets++;

    updateSuhuUI(state.suhu);
    updateApiUI(state.api, state.suhu);
    updateLoraUI(true);
    updateLedRow();
    triggerAlerts(state.suhu, state.api);

    // Header time update
    if (d.timestamp) {
      const dt = new Date(parseInt(d.timestamp));
      $("headerTime").textContent = dt.toLocaleTimeString("id-ID");
    }

  }, err => {
    console.warn("Firebase error:", err);
    state.firebaseOk = false;
    state.loraOnline = false;
    updateLoraUI(false);
    updateConnBadge(false);
    setTicker("⚠ Koneksi Firebase terputus — periksa konfigurasi", false);
  });
}

// ================================================================
//  FIREBASE: LISTEN HISTORY (7 HARI)
// ================================================================
function listenHistory() {
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const histRef = query(
    ref(db, "history"),
    orderByChild("timestamp"),
    startAt(sevenDaysAgo),
    limitToLast(2016)  // max ~7 hari @ 5 menit interval
  );

  onValue(histRef, snap => {
    if (!snap.exists()) return;

    const rows = [];
    snap.forEach(child => rows.push(child.val()));
    state.allHistory = rows;

    computeStats(rows);
    renderChart(state.chartRange);
  });
}

// ================================================================
//  STATISTIK DARI HISTORY
// ================================================================
function computeStats(rows) {
  if (!rows.length) return;

  const now     = Date.now();
  const day1ago = now - 86400000;
  const day7ago = now - 7 * 86400000;

  const rows24h = rows.filter(r => r.timestamp >= day1ago);
  const rows7d  = rows.filter(r => r.timestamp >= day7ago);

  if (rows24h.length) {
    const vals   = rows24h.map(r => parseFloat(r.suhu));
    state.max24h = Math.max(...vals);
    state.min24h = Math.min(...vals);
    state.avg24h = vals.reduce((a,b) => a+b, 0) / vals.length;

    $("suhuMax24").textContent = state.max24h.toFixed(1) + "°";
    $("suhuMin24").textContent = state.min24h.toFixed(1) + "°";
    $("suhuAvg24").textContent = state.avg24h.toFixed(1) + "°";
  }

  state.apiToday = rows24h.filter(r => parseInt(r.api) === 1).length;
  state.api7d    = rows7d.filter(r => parseInt(r.api) === 1).length;

  $("apiToday").textContent = state.apiToday + "x";
  $("api7d").textContent    = state.api7d + "x";

  // Terakhir terdeteksi api
  const fireLogs = rows7d.filter(r => parseInt(r.api) === 1);
  if (fireLogs.length) {
    const last = fireLogs[fireLogs.length - 1];
    state.apiLastTime = last.timestamp;
    $("apiLast").textContent = new Date(parseInt(last.timestamp))
      .toLocaleString("id-ID", { dateStyle:"short", timeStyle:"short" });
  }
}

// ================================================================
//  UPDATE UI: SUHU
// ================================================================
function updateSuhuUI(suhu) {
  $("gaugeVal").textContent = suhu.toFixed(1);

  // Gauge arc: max 100°C = full arc (471 / 565 dasharray on a 270° sweep)
  const pct    = Math.min(suhu / 100, 1);
  const arcLen = 471;  // full arc length at r=90 for 270°
  const fill   = pct * arcLen;
  $("gaugeFill").style.strokeDasharray = fill + " 565";

  // Bar
  $("suhuBarFill").style.width = Math.min(pct * 100, 100) + "%";

  // Color states
  const gaugeFill = $("gaugeFill");
  const gaugeVal  = $("gaugeVal");
  const badge     = $("suhuBadge");
  const card      = $("cardSuhu");

  if (suhu > 60) {
    gaugeFill.style.stroke = "#ff2b2b";
    gaugeVal.style.color   = "#ff2b2b";
    badge.textContent = "BAHAYA";
    badge.className   = "card-badge danger";
    card.classList.add("danger-state");
    card.classList.remove("warn-state");
  } else if (suhu > 40) {
    gaugeFill.style.stroke = "#ff9300";
    gaugeVal.style.color   = "#ff9300";
    badge.textContent = "PERINGATAN";
    badge.className   = "card-badge warn";
    card.classList.add("warn-state");
    card.classList.remove("danger-state");
  } else {
    gaugeFill.style.stroke = "";
    gaugeVal.style.color   = "";
    badge.textContent = "NORMAL";
    badge.className   = "card-badge";
    card.classList.remove("danger-state", "warn-state");
  }
}

// ================================================================
//  UPDATE UI: API
// ================================================================
function updateApiUI(api, suhu) {
  const ring    = $("apiRing");
  const icon    = $("apiIcon");
  const label   = $("apiStatusLabel");
  const sub     = $("apiSubLabel");
  const badge   = $("apiBadge");
  const card    = $("cardApi");
  const sigDot  = $("signalDot");

  if (api === 1) {
    ring.classList.add("danger");
    label.textContent = "API TERDETEKSI!";
    label.className   = "api-label danger";
    sub.textContent   = "Sensor mendeteksi api aktif";
    badge.textContent = "DARURAT";
    badge.className   = "card-badge danger";
    card.classList.add("danger-state");
    sigDot.classList.add("danger");
    sigDot.classList.remove("active");
    // Flame icon visible
    icon.querySelector("#flamePath").style.opacity  = "0.8";
    icon.querySelector("#flamePath2").style.opacity = "0.9";
    setTicker("🔥 API TERDETEKSI! Segera lakukan pengecekan lokasi!", true);
  } else {
    ring.classList.remove("danger");
    label.textContent = "AMAN";
    label.className   = "api-label";
    sub.textContent   = "Tidak ada deteksi api";
    badge.textContent = "STANDBY";
    badge.className   = "card-badge";
    card.classList.remove("danger-state");
    sigDot.classList.remove("danger");
    sigDot.classList.add("active");
    icon.querySelector("#flamePath").style.opacity  = "0.15";
    icon.querySelector("#flamePath2").style.opacity = "0.3";

    if (suhu > 60) {
      setTicker(`⚠ Suhu tinggi: ${suhu.toFixed(1)}°C — Melebihi batas aman 60°C`, false);
    } else {
      setTicker(`✓ Sistem aktif — Suhu: ${suhu.toFixed(1)}°C | Status: AMAN`, false);
    }
  }
}

// ================================================================
//  UPDATE UI: LORA / KONEKSI
// ================================================================
function updateLoraUI(online) {
  const txt   = $("loraStatusText");
  const since = $("loraSince");
  const badge = $("connBadge");
  const text  = $("connText");

  $("lstatPackets").textContent = state.packets;

  if (online) {
    txt.textContent = "TERHUBUNG";
    txt.className   = "lora-status-text online";
    since.textContent = "Data LoRa diterima";
    updateConnBadge(true);
  } else {
    txt.textContent = "OFFLINE";
    txt.className   = "lora-status-text offline";
    since.textContent = "Tidak ada sinyal LoRa";
    updateConnBadge(false);
  }
}

function updateConnBadge(ok) {
  const badge = $("connBadge");
  const text  = $("connText");
  if (ok) {
    badge.className   = "conn-badge online";
    text.textContent  = "ONLINE";
  } else {
    badge.className   = "conn-badge offline";
    text.textContent  = "OFFLINE";
  }
}

function updateLedRow() {
  const lledLora  = $("lledLora");
  const lledFb    = $("lledWifi");
  const lledAlert = $("lledAlert");

  lledLora.className  = state.loraOnline ? "lled on" : "lled off";
  lledFb.className    = state.firebaseOk ? "lled on" : "lled off";
  lledAlert.className = emailList.length  ? "lled on" : "lled";
}

// ================================================================
//  TRIGGER ALERTS (Email + Overlay)
// ================================================================
function triggerAlerts(suhu, api) {
  const now = Date.now();

  if (api === 1 && (now - state.lastFireAlert > state.COOLDOWN)) {
    state.lastFireAlert = now;
    sendEmailAlert(
      "🔥 DARURAT — API TERDETEKSI",
      `API TERDETEKSI oleh sensor LoRa!\n\nSuhu saat ini: ${suhu.toFixed(1)} °C\nWaktu: ${new Date().toLocaleString("id-ID")}\n\nSegera periksa lokasi!`
    );
    showAlert("🔥", "API TERDETEKSI!", `Suhu: ${suhu.toFixed(1)}°C — Email notifikasi dikirim ke ${emailList.length} penerima`);
  }

  if (suhu > 60 && api === 0 && (now - state.lastHeatAlert > state.COOLDOWN)) {
    state.lastHeatAlert = now;
    sendEmailAlert(
      "⚠ PERINGATAN — SUHU TINGGI",
      `Suhu melebihi batas aman!\n\nSuhu saat ini: ${suhu.toFixed(1)} °C\nBatas aman: 60 °C\nWaktu: ${new Date().toLocaleString("id-ID")}\n\nSegera periksa kondisi area.`
    );
    showToast(`⚠ Suhu ${suhu.toFixed(1)}°C — email peringatan dikirim`, "warn");
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

  const cutoff  = Date.now() - rangeDays * 86400000;
  const filtered = rows.filter(r => r.timestamp >= cutoff);
  if (!filtered.length) return;

  // Downsample ke max 200 titik
  const step   = Math.max(1, Math.floor(filtered.length / 200));
  const labels = [];
  const data   = [];
  const colors = [];
  const apiDots = [];

  filtered.forEach((r, i) => {
    if (i % step !== 0) return;
    const d  = new Date(parseInt(r.timestamp));
    const lb = rangeDays <= 1
      ? d.toLocaleTimeString("id-ID", { hour:"2-digit", minute:"2-digit" })
      : d.toLocaleString("id-ID", { month:"short", day:"numeric", hour:"2-digit", minute:"2-digit" });

    labels.push(lb);
    data.push(parseFloat(r.suhu));
    colors.push(
      parseFloat(r.suhu) > 60 ? "rgba(255,43,43,0.9)" :
      parseFloat(r.suhu) > 40 ? "rgba(255,147,0,0.9)" :
                                  "rgba(0,255,224,0.9)"
    );
    apiDots.push(parseInt(r.api) === 1 ? parseFloat(r.suhu) : null);
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
          label:           "Suhu °C",
          data,
          borderWidth:     1.5,
          borderColor:     ctx => {
            // per-point colors via segment
            return "rgba(0,255,224,0.8)";
          },
          pointRadius:     0,
          pointHoverRadius:4,
          tension:         0.4,
          fill:            true,
          backgroundColor: grad,
          segment: {
            borderColor: ctx2 => {
              const v = ctx2.p1.parsed.y;
              return v > 60 ? "rgba(255,43,43,0.9)" :
                     v > 40 ? "rgba(255,147,0,0.9)" :
                               "rgba(0,255,224,0.8)";
            }
          }
        },
        {
          label:           "Deteksi Api",
          data:            apiDots,
          type:            "scatter",
          pointRadius:     5,
          pointHoverRadius:7,
          pointBackgroundColor: "rgba(255,43,43,0.9)",
          pointBorderColor:     "#ff2b2b",
          showLine:        false,
        }
      ]
    },
    options: {
      responsive:          true,
      maintainAspectRatio: false,
      interaction:         { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "rgba(13,21,32,0.95)",
          borderColor:     "rgba(0,255,224,0.2)",
          borderWidth:     1,
          titleFont:       { family: "'Share Tech Mono'" },
          bodyFont:        { family: "'Share Tech Mono'" },
          callbacks: {
            label: ctx => {
              if (ctx.datasetIndex === 0) return ` Suhu: ${ctx.parsed.y.toFixed(1)}°C`;
              if (ctx.parsed.y !== null) return " 🔥 API TERDETEKSI";
              return null;
            }
          }
        }
      },
      scales: {
        x: {
          ticks: {
            color:        "rgba(74,96,112,0.8)",
            font:         { family: "'Share Tech Mono'", size: 10 },
            maxTicksLimit: 8,
            maxRotation:  0,
          },
          grid: { color: "rgba(255,255,255,0.03)" }
        },
        y: {
          min:  0,
          ticks: {
            color: "rgba(74,96,112,0.8)",
            font:  { family: "'Share Tech Mono'", size: 10 },
            callback: v => v + "°"
          },
          grid: { color: "rgba(255,255,255,0.04)" }
        }
      }
    }
  });
}

// Chart tab switching
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
function renderEmailList() {
  const list  = $("emailList");
  const empty = $("elistEmpty");
  const count = $("emailCount");

  count.textContent = emailList.length + " email";

  if (!emailList.length) {
    empty.style.display = "flex";
    // remove all items
    list.querySelectorAll(".email-item").forEach(el => el.remove());
    return;
  }
  empty.style.display = "none";

  list.querySelectorAll(".email-item").forEach(el => el.remove());
  emailList.forEach((email, idx) => {
    const item = document.createElement("div");
    item.className = "email-item";
    item.innerHTML = `
      <span class="email-item-addr" title="${email}">${email}</span>
      <button class="email-item-del" onclick="removeEmail(${idx})" title="Hapus">✕</button>
    `;
    list.appendChild(item);
  });

  updateLedRow();
}

window.addEmail = () => {
  const inp   = $("emailInput");
  const hint  = $("emailHint");
  const email = inp.value.trim().toLowerCase();

  if (!email) {
    hint.textContent = "Masukkan alamat email.";
    hint.className   = "eform-hint error";
    return;
  }
  const emailReg = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailReg.test(email)) {
    hint.textContent = "Format email tidak valid.";
    hint.className   = "eform-hint error";
    return;
  }
  if (emailList.includes(email)) {
    hint.textContent = "Email sudah ada dalam daftar.";
    hint.className   = "eform-hint error";
    return;
  }

  emailList.push(email);
  localStorage.setItem("fg_emails", JSON.stringify(emailList));
  inp.value = "";
  hint.textContent = "✓ Email berhasil ditambahkan!";
  hint.className   = "eform-hint success";
  renderEmailList();
  showToast("Email ditambahkan: " + email, "success");

  setTimeout(() => { hint.textContent = ""; hint.className = "eform-hint"; }, 3000);
};

window.removeEmail = idx => {
  const removed = emailList.splice(idx, 1)[0];
  localStorage.setItem("fg_emails", JSON.stringify(emailList));
  renderEmailList();
  showToast("Email dihapus: " + removed);
};

// Enter key untuk tambah email
$("emailInput").addEventListener("keydown", e => {
  if (e.key === "Enter") window.addEmail();
});

// ================================================================
//  KIRIM EMAIL VIA EMAILJS
// ================================================================
function sendEmailAlert(subject, body) {
  if (!window.emailjs) {
    console.warn("EmailJS belum dimuat");
    return;
  }
  if (!emailList.length) return;

  emailList.forEach(email => {
    emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, {
      to_email:   email,
      subject:    subject,
      message:    body,
      time:       new Date().toLocaleString("id-ID"),
      suhu:       state.suhu.toFixed(1),
      api_status: state.api === 1 ? "API TERDETEKSI" : "AMAN",
    }).then(
      () => console.log("Email terkirim ke:", email),
      err => console.warn("Email gagal ke:", email, err)
    );
  });
}

window.sendTestEmail = () => {
  if (!emailList.length) {
    showToast("Tambahkan email penerima terlebih dahulu.", "error");
    return;
  }
  sendEmailAlert(
    "✅ TEST — FireGuard Monitoring System",
    `Ini adalah email percobaan dari FireGuard.\n\nSistem berjalan normal.\nSuhu saat ini: ${state.suhu.toFixed(1)} °C\nStatus Api: ${state.api === 1 ? "TERDETEKSI" : "AMAN"}\nWaktu: ${new Date().toLocaleString("id-ID")}`
  );
  showToast("Test email dikirim ke " + emailList.length + " penerima.", "success");
};

// ================================================================
//  INIT
// ================================================================
renderEmailList();
updateConnBadge(false);
setTicker("Sistem aktif — Menghubungkan ke Firebase...");

listenLatest();
listenHistory();
