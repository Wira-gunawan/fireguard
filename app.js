// ================================================================
//  app.js — FireGuard Monitoring  (FIXED VERSION)
//  PERBAIKAN:
//  [1] Email disimpan ke Firebase (bukan localStorage)
//  [2] Grafik fix: query history tanpa startAt (kompatibel rules)
//  [3] Email alert fix: EmailJS init dipastikan sebelum kirim
//  [4] Sensor timeout: otomatis OFFLINE jika data > 15 detik
// ================================================================

import { initializeApp }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getDatabase, ref, onValue, query,
  orderByChild, limitToLast,
  push, remove, set
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

// ================================================================
//  KONFIGURASI FIREBASE  (sudah sesuai project Anda)
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
//  KONFIGURASI EMAILJS  (sudah sesuai akun Anda)
// ================================================================
const EMAILJS_PUBLIC_KEY  = "4v6PI9FmKo9bqOz1Z";
const EMAILJS_SERVICE_ID  = "service_l9lxqu8";
const EMAILJS_TEMPLATE_ID = "template_f5yblhn";

// ================================================================
//  INISIALISASI FIREBASE
// ================================================================
const app = initializeApp(firebaseConfig);
const db  = getDatabase(app);

// ================================================================
//  INISIALISASI EMAILJS — tunggu sampai script benar-benar siap
// ================================================================
let emailJsReady = false;

function initEmailJS() {
  if (window.emailjs) {
    emailjs.init(EMAILJS_PUBLIC_KEY);
    emailJsReady = true;
    console.log("[EmailJS] Siap");
  } else {
    // Coba lagi 500ms kemudian jika script belum dimuat
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
  firebaseOk:   false,
  packets:      0,
  startTime:    Date.now(),

  lastFireAlert: 0,
  lastHeatAlert: 0,
  COOLDOWN:      5 * 60 * 1000,   // 5 menit

  max24h: null, min24h: null, avg24h: null,
  apiToday: 0,  api7d: 0,    apiLastTime: null,

  chartRange:  1,
  allHistory:  [],
};

// FIX [1]: email sekarang array of {key, email} dari Firebase
let emailList = [];

// FIX [4]: timestamp terakhir dari sensor
let lastSensorTimestamp = null;
const SENSOR_TIMEOUT_MS = 15000;  // 15 detik

// ================================================================
//  DOM HELPERS
// ================================================================
const $ = id => document.getElementById(id);

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
//  UPTIME
// ================================================================
function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}h ${h % 24}j`;
  if (h > 0) return `${h}j ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}d`;
  return `${s}d`;
}

setInterval(() => {
  const up = formatUptime(Date.now() - state.startTime);
  $("lstatUptime").textContent  = up;
  $("footerUptime").textContent = "Uptime: " + up;
}, 1000);

// ================================================================
//  WAKTU HEADER
// ================================================================
setInterval(() => {
  $("headerTime").textContent = new Date().toLocaleTimeString("id-ID");
}, 1000);
$("headerTime").textContent = new Date().toLocaleTimeString("id-ID");

// ================================================================
//  FIX [4]: CEK TIMEOUT SENSOR setiap 5 detik
//  Jika data terakhir > 15 detik → tandai OFFLINE
// ================================================================
setInterval(() => {
  if (lastSensorTimestamp === null) return;

  const selisih = Date.now() - lastSensorTimestamp;
  if (selisih > SENSOR_TIMEOUT_MS && state.loraOnline) {
    state.loraOnline = false;
    updateLoraUI(false);
    updateConnBadge(false);
    updateLedRow();

    // Reset tampilan ke "--"
    $("gaugeVal").textContent        = "--";
    $("suhuBadge").textContent       = "OFFLINE";
    $("suhuBadge").className         = "card-badge warn";
    $("apiBadge").textContent        = "OFFLINE";
    $("apiBadge").className          = "card-badge warn";
    $("apiStatusLabel").textContent  = "TIDAK DIKETAHUI";
    $("apiSubLabel").textContent     = "Sensor offline atau tidak ada sinyal";
    $("apiRing").classList.remove("danger");
    $("signalDot").classList.remove("active", "danger");
    $("suhuBarFill").style.width     = "0%";
    $("gaugeFill").style.strokeDasharray = "0 565";

    setTicker("⚠ Sensor offline — tidak ada data masuk lebih dari " +
      Math.floor(selisih / 1000) + " detik", false);
  }
}, 5000);

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

    // Simpan timestamp untuk cek timeout
    lastSensorTimestamp = d.timestamp ? parseInt(d.timestamp) : Date.now();

    updateSuhuUI(state.suhu);
    updateApiUI(state.api, state.suhu);
    updateLoraUI(true);
    updateLedRow();
    triggerAlerts(state.suhu, state.api);

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
//  FIX [2]: FIREBASE HISTORY — query tanpa startAt
//  startAt() butuh index di rules, ini versi yang selalu bekerja
// ================================================================
function listenHistory() {
  // Ambil 2016 data terakhir (~7 hari jika interval 5 menit)
  const histRef = query(
    ref(db, "history"),
    orderByChild("timestamp"),
    limitToLast(2016)
  );

  onValue(histRef, snap => {
    if (!snap.exists()) {
      console.log("[History] Belum ada data history");
      return;
    }

    const rows = [];
    snap.forEach(child => {
      const val = child.val();
      // Pastikan data valid sebelum dipakai
      if (val && val.timestamp && val.suhu !== undefined) {
        rows.push({
          suhu:      parseFloat(val.suhu),
          api:       parseInt(val.api || 0),
          timestamp: parseInt(val.timestamp)
        });
      }
    });

    console.log("[History] Data diterima:", rows.length, "baris");

    // Filter 7 hari terakhir di sisi client
    const tujuhHariLalu = Date.now() - 7 * 24 * 60 * 60 * 1000;
    state.allHistory = rows.filter(r => r.timestamp >= tujuhHariLalu);

    if (state.allHistory.length > 0) {
      $("chartEmpty").classList.add("hidden");
      computeStats(state.allHistory);
      renderChart(state.chartRange);
    }
  }, err => {
    console.error("[History] Error:", err);
    // Jika error karena rules, tampilkan pesan
    setTicker("⚠ Gagal memuat history — cek Firebase Rules", false);
  });
}

// ================================================================
//  STATISTIK
// ================================================================
function computeStats(rows) {
  if (!rows.length) return;

  const now     = Date.now();
  const day1ago = now - 86400000;
  const day7ago = now - 7 * 86400000;

  const rows24h = rows.filter(r => r.timestamp >= day1ago);
  const rows7d  = rows.filter(r => r.timestamp >= day7ago);

  if (rows24h.length) {
    const vals   = rows24h.map(r => r.suhu);
    state.max24h = Math.max(...vals);
    state.min24h = Math.min(...vals);
    state.avg24h = vals.reduce((a, b) => a + b, 0) / vals.length;

    $("suhuMax24").textContent = state.max24h.toFixed(1) + "°";
    $("suhuMin24").textContent = state.min24h.toFixed(1) + "°";
    $("suhuAvg24").textContent = state.avg24h.toFixed(1) + "°";
  }

  state.apiToday = rows24h.filter(r => r.api === 1).length;
  state.api7d    = rows7d.filter(r => r.api === 1).length;

  $("apiToday").textContent = state.apiToday + "x";
  $("api7d").textContent    = state.api7d + "x";

  const fireLogs = rows7d.filter(r => r.api === 1);
  if (fireLogs.length) {
    const last = fireLogs[fireLogs.length - 1];
    $("apiLast").textContent = new Date(last.timestamp)
      .toLocaleString("id-ID", { dateStyle: "short", timeStyle: "short" });
  }
}

// ================================================================
//  UPDATE UI: SUHU
// ================================================================
function updateSuhuUI(suhu) {
  $("gaugeVal").textContent = suhu.toFixed(1);

  const pct  = Math.min(suhu / 100, 1);
  const fill = pct * 471;
  $("gaugeFill").style.strokeDasharray = fill + " 565";
  $("suhuBarFill").style.width = Math.min(pct * 100, 100) + "%";

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
  const ring   = $("apiRing");
  const icon   = $("apiIcon");
  const label  = $("apiStatusLabel");
  const sub    = $("apiSubLabel");
  const badge  = $("apiBadge");
  const card   = $("cardApi");
  const sigDot = $("signalDot");

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
  $("lstatPackets").textContent = state.packets;

  if (online) {
    $("loraStatusText").textContent = "TERHUBUNG";
    $("loraStatusText").className   = "lora-status-text online";
    $("loraSince").textContent      = "Data LoRa diterima";
    updateConnBadge(true);
  } else {
    $("loraStatusText").textContent = "OFFLINE";
    $("loraStatusText").className   = "lora-status-text offline";
    $("loraSince").textContent      = "Tidak ada sinyal LoRa";
    updateConnBadge(false);
  }
}

function updateConnBadge(ok) {
  $("connBadge").className  = "conn-badge " + (ok ? "online" : "offline");
  $("connText").textContent = ok ? "ONLINE" : "OFFLINE";
}

function updateLedRow() {
  $("lledLora").className  = state.loraOnline  ? "lled on"  : "lled off";
  $("lledWifi").className  = state.firebaseOk  ? "lled on"  : "lled off";
  $("lledAlert").className = emailList.length  ? "lled on"  : "lled";
}

// ================================================================
//  TRIGGER ALERTS
// ================================================================
function triggerAlerts(suhu, api) {
  const now = Date.now();

  if (api === 1 && (now - state.lastFireAlert > state.COOLDOWN)) {
    state.lastFireAlert = now;
    sendEmailAlert(
      "🔥 DARURAT — API TERDETEKSI",
      `API TERDETEKSI oleh sensor LoRa!\n\nSuhu saat ini: ${suhu.toFixed(1)} °C\nWaktu: ${new Date().toLocaleString("id-ID")}\n\nSegera periksa lokasi!`
    );
    showAlert("🔥", "API TERDETEKSI!",
      `Suhu: ${suhu.toFixed(1)}°C — Email dikirim ke ${emailList.length} penerima`);
  }

  if (suhu > 60 && api === 0 && (now - state.lastHeatAlert > state.COOLDOWN)) {
    state.lastHeatAlert = now;
    sendEmailAlert(
      "⚠ PERINGATAN — SUHU TINGGI",
      `Suhu melebihi batas aman!\n\nSuhu: ${suhu.toFixed(1)} °C\nBatas: 60 °C\nWaktu: ${new Date().toLocaleString("id-ID")}\n\nSegera periksa area.`
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

  const cutoff   = Date.now() - rangeDays * 86400000;
  const filtered = rows.filter(r => r.timestamp >= cutoff);

  if (!filtered.length) {
    $("chartEmpty").classList.remove("hidden");
    $("chartEmpty").querySelector(".ce-text").textContent =
      "Tidak ada data untuk rentang ini";
    return;
  }

  const step    = Math.max(1, Math.floor(filtered.length / 200));
  const labels  = [];
  const data    = [];
  const apiDots = [];

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

  const ctx  = $("suhuChart").getContext("2d");
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
          label:            "Suhu °C",
          data,
          borderWidth:      1.5,
          pointRadius:      0,
          pointHoverRadius: 4,
          tension:          0.4,
          fill:             true,
          backgroundColor:  grad,
          segment: {
            borderColor: c => {
              const v = c.p1.parsed.y;
              return v > 60 ? "rgba(255,43,43,0.9)"  :
                     v > 40 ? "rgba(255,147,0,0.9)"  :
                               "rgba(0,255,224,0.8)";
            }
          }
        },
        {
          label:                "Deteksi Api",
          data:                 apiDots,
          type:                 "scatter",
          pointRadius:          5,
          pointHoverRadius:     7,
          pointBackgroundColor: "rgba(255,43,43,0.9)",
          pointBorderColor:     "#ff2b2b",
          showLine:             false,
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
            label: c => {
              if (c.datasetIndex === 0) return ` Suhu: ${c.parsed.y.toFixed(1)}°C`;
              if (c.parsed.y !== null)  return " 🔥 API TERDETEKSI";
              return null;
            }
          }
        }
      },
      scales: {
        x: {
          ticks: {
            color:         "rgba(74,96,112,0.8)",
            font:          { family: "'Share Tech Mono'", size: 10 },
            maxTicksLimit: 8,
            maxRotation:   0,
          },
          grid: { color: "rgba(255,255,255,0.03)" }
        },
        y: {
          min:  0,
          ticks: {
            color:    "rgba(74,96,112,0.8)",
            font:     { family: "'Share Tech Mono'", size: 10 },
            callback: v => v + "°"
          },
          grid: { color: "rgba(255,255,255,0.04)" }
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
//  FIX [1]: EMAIL MANAGEMENT — SIMPAN KE FIREBASE /emails
// ================================================================

// Load email dari Firebase saat halaman dibuka
function loadEmails() {
  const emailsRef = ref(db, "emails");
  onValue(emailsRef, snap => {
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
  const count = $("emailCount");

  count.textContent = emailList.length + " email";
  list.querySelectorAll(".email-item").forEach(el => el.remove());

  if (!emailList.length) {
    empty.style.display = "flex";
    return;
  }

  empty.style.display = "none";
  emailList.forEach(item => {
    const div = document.createElement("div");
    div.className = "email-item";
    div.innerHTML = `
      <span class="email-item-addr" title="${item.email}">${item.email}</span>
      <button class="email-item-del"
        onclick="removeEmail('${item.key}')" title="Hapus">✕</button>
    `;
    list.appendChild(div);
  });
}

window.addEmail = async () => {
  const inp   = $("emailInput");
  const hint  = $("emailHint");
  const email = inp.value.trim().toLowerCase();

  hint.textContent = "";
  hint.className   = "eform-hint";

  if (!email) {
    hint.textContent = "Masukkan alamat email.";
    hint.className   = "eform-hint error";
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    hint.textContent = "Format email tidak valid.";
    hint.className   = "eform-hint error";
    return;
  }
  if (emailList.find(e => e.email === email)) {
    hint.textContent = "Email sudah ada dalam daftar.";
    hint.className   = "eform-hint error";
    return;
  }

  try {
    await push(ref(db, "emails"), { email });
    inp.value        = "";
    hint.textContent = "✓ Email berhasil disimpan ke database!";
    hint.className   = "eform-hint success";
    showToast("Email ditambahkan: " + email, "success");
    setTimeout(() => { hint.textContent = ""; hint.className = "eform-hint"; }, 3000);
  } catch (err) {
    hint.textContent = "Gagal simpan: " + err.message;
    hint.className   = "eform-hint error";
    console.error("[Email] Gagal push:", err);
  }
};

window.removeEmail = async (key) => {
  try {
    await remove(ref(db, "emails/" + key));
    showToast("Email dihapus.", "");
  } catch (err) {
    showToast("Gagal hapus: " + err.message, "error");
  }
};

$("emailInput").addEventListener("keydown", e => {
  if (e.key === "Enter") window.addEmail();
});

// ================================================================
//  FIX [3]: KIRIM EMAIL — pastikan EmailJS siap sebelum kirim
// ================================================================
function sendEmailAlert(subject, body) {
  if (!emailJsReady) {
    console.warn("[EmailJS] Belum siap, coba init ulang...");
    initEmailJS();
    // Coba lagi setelah 1 detik
    setTimeout(() => sendEmailAlert(subject, body), 1000);
    return;
  }
  if (!emailList.length) {
    console.warn("[EmailJS] Tidak ada penerima terdaftar");
    return;
  }

  emailList.forEach(item => {
    emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, {
      to_email:   item.email,          // FIX: pakai item.email bukan item
      subject:    subject,
      message:    body,
      time:       new Date().toLocaleString("id-ID"),
      suhu:       state.suhu.toFixed(1),
      api_status: state.api === 1 ? "API TERDETEKSI" : "AMAN",
    }).then(
      ()  => console.log("[EmailJS] Terkirim ke:", item.email),
      err => console.error("[EmailJS] Gagal ke:", item.email, err)
    );
  });
}

window.sendTestEmail = () => {
  if (!emailList.length) {
    showToast("Tambahkan email penerima terlebih dahulu.", "error");
    return;
  }
  if (!emailJsReady) {
    showToast("EmailJS belum siap, tunggu sebentar...", "warn");
    return;
  }
  sendEmailAlert(
    "✅ TEST — FireGuard Monitoring System",
    `Ini adalah email percobaan dari FireGuard.\n\nSistem berjalan normal.\nSuhu: ${state.suhu.toFixed(1)} °C\nStatus: ${state.api === 1 ? "API TERDETEKSI" : "AMAN"}\nWaktu: ${new Date().toLocaleString("id-ID")}`
  );
  showToast("Test email dikirim ke " + emailList.length + " penerima.", "success");
};

// ================================================================
//  INIT — urutan penting!
// ================================================================
updateConnBadge(false);
setTicker("Sistem aktif — Menghubungkan ke Firebase...");

loadEmails();      // [1] Load email dari Firebase
listenLatest();    // [2] Dengarkan data realtime
listenHistory();   // [3] Load history untuk grafik
