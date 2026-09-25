// Title bar buttons
const { ipcRenderer } = require("electron");
const minimizeBtn = document.getElementById("minimize");
const closeBtn = document.getElementById("close");

minimizeBtn.addEventListener("click", () =>
  ipcRenderer.send("window:minimize"),
);
closeBtn.addEventListener("click", () => ipcRenderer.send("window:close"));

// Water meter mechanic
// -- Configuration --
const drain_amount = 1; // % to drain per tick
const drain_interval = 900; // 1% per 0.9s = fully drained in 90s
const water_cooldown = 10000; // 10s cooldown after watering

// Sunlight mechanic
// -- Configuration --
const sun_boost_duration = 30000; // how long a sunlight boost lasts
const sun_cooldown = 20000; // cooldown after a boost ends before it can be used again

// -- Plant types --
// Each plant has a display name, one sprite per mood stage, and one
// care-reminder message per mood stage. Add new plants here.
const PLANTS = {
  flowey: {
    name: "Flowey",
    sprites: {
      thriving: "assets/flowery-plant/flowey-thriving.gif",
      okay: "assets/flowery-plant/flowey-okay.gif",
      thirsty: "assets/flowery-plant/flowey-thirsty.gif",
      wilted: "assets/flowery-plant/flowey-wilted.gif",
    },
    messages: {
      thriving: "- Howdy! I'm feeling great! -",
      okay: "- I'm doing alright, I guess -",
      thirsty: "- Water... could really use some... -",
      wilted: "- You IDIOT. Water me... -",
    },
  },
};

const PLANT_KEYS = Object.keys(PLANTS);

// -- State --
let water_level = 100;
let water_on_cooldown = false;
let cooldown_timer = null;

let sun_boost_active = false;
let sun_on_cooldown = false;
let sun_boost_timer = null;
let sun_cooldown_timer = null;
let skip_next_drain = false; // used to halve the drain rate during a sun boost

let lastNotifiedStage = null; // avoids spamming a notification every tick

let currentPlant = localStorage.getItem("plantType") || PLANT_KEYS[0];
if (!PLANTS[currentPlant]) currentPlant = PLANT_KEYS[0];
let currentPlantIndex = PLANT_KEYS.indexOf(currentPlant);

// -- Elements --
const bars = Array.from({ length: 10 }, (_, i) =>
  document.getElementById(`bar-${i + 1}`),
);
const percentage_el = document.getElementById("percentage");
const mood_tag = document.getElementById("mood");
const plant_icon = document.getElementById("plant");
const plant_name_el = document.getElementById("plants-name");
const care_reminder = document.getElementById("message");
const water_btn = document.getElementById("water-btn");
const water_timer_el = water_btn.querySelector(".timer");
const sun_btn = document.getElementById("sun-btn");
const sun_timer_el = sun_btn.querySelector(".timer");
const restart_btn = document.getElementById("restart-btn");

// -- Plant switching --
// Click the plant's name in the title bar to cycle to the next plant.
// The chosen plant is remembered between app launches.
plant_name_el.style.cursor = "pointer";
plant_name_el.title = "Click to switch plant";
plant_name_el.addEventListener("click", () => {
  currentPlantIndex = (currentPlantIndex + 1) % PLANT_KEYS.length;
  currentPlant = PLANT_KEYS[currentPlantIndex];
  localStorage.setItem("plantType", currentPlant);
  updateUI();
});

// -- Notifications --
// Ask for OS notification permission once, up front. Electron generally
// grants this immediately without a prompt, but we check anyway in case
// the person's OS/security settings require it.
if ("Notification" in window && Notification.permission === "default") {
  Notification.requestPermission();
}

function sendNotification(title, body, icon) {
  if (!("Notification" in window)) return;
  const show = () => {
    try {
      new Notification(title, { body, icon });
    } catch (err) {
      console.error("Notification failed:", err);
    }
  };
  if (Notification.permission === "granted") {
    show();
  } else if (Notification.permission !== "denied") {
    Notification.requestPermission().then((permission) => {
      if (permission === "granted") show();
    });
  }
}

// Fires a notification the moment the plant *crosses into* thirsty or
// wilted (not on every tick while it stays there), and resets once the
// plant recovers so it can fire again next time.
function maybeNotify(stage, plant) {
  const needsAttention = stage === "thirsty" || stage === "wilted";

  if (needsAttention && stage !== lastNotifiedStage) {
    const title =
      stage === "wilted"
        ? `${plant.name} has wilted!`
        : `${plant.name} is getting thirsty`;
    const body =
      stage === "wilted"
        ? "It needs water right away."
        : "Give it some water soon.";
    sendNotification(title, body, plant.sprites[stage]);
  }

  lastNotifiedStage = needsAttention ? stage : null;
}

// -- Render --
function updateUI() {
  const plant = PLANTS[currentPlant];

  // update plant name in title bar
  plant_name_el.textContent = plant.name;

  // update bars: each bar = 10%
  // bar n is filled if water_level > 10
  percentage_el.textContent = `${water_level}%`;
  bars.forEach((bar, i) => {
    const threshold = i * 10;
    const filled = water_level > threshold;
    bar.style.background = filled ? "#8FC98A" : "#C2E0B8";
    bar.style.color = filled ? "#8FC98A" : "#C2E0B8";
  });

  // figure out mood stage from water level
  let stage;
  if (water_level > 74) {
    stage = "thriving"; // 75-100%
  } else if (water_level > 39) {
    stage = "okay"; // 40-74%
  } else if (water_level > 0) {
    stage = "thirsty"; // 1-39%
  } else {
    stage = "wilted"; // 0%
  }

  // apply the current plant's sprite + message for this stage
  plant_icon.src = plant.sprites[stage];
  mood_tag.textContent = stage.charAt(0).toUpperCase() + stage.slice(1);
  care_reminder.textContent = plant.messages[stage];

  // golden glow while a sunlight boost is active
  plant_icon.classList.toggle("sun-boosted", sun_boost_active);

  if (stage === "wilted") {
    restart_btn.style.display = "flex";
    water_btn.style.display = "none";
    sun_btn.style.display = "none";
  } else {
    restart_btn.style.display = "none";
    water_btn.style.display = "flex";
    sun_btn.style.display = "flex";
  }

  maybeNotify(stage, plant);
}

// -- Drain loop --
setInterval(() => {
  if (water_level <= 0) return;

  // while a sunlight boost is active, only drain every other tick
  // (effectively halves the water consumption rate)
  if (sun_boost_active) {
    skip_next_drain = !skip_next_drain;
    if (skip_next_drain) return;
  }

  water_level = Math.max(0, water_level - drain_amount);
  updateUI();
}, drain_interval);

// -- Water button --
water_btn.addEventListener("click", () => {
  if (water_on_cooldown) return;
  water_level = Math.min(100, water_level + 25); // Refill per use = +25%
  updateUI();
  // start cooldown
  water_on_cooldown = true;
  water_btn.disabled = true;
  water_btn.style.opacity = 0.5;
  let remaining = water_cooldown / 1000;
  water_timer_el.textContent = `${remaining}s`;
  // cooldown timer
  cooldown_timer = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      clearInterval(cooldown_timer);
      water_on_cooldown = false;
      water_btn.disabled = false;
      water_btn.style.opacity = 1;
      water_timer_el.textContent = "READY";
    } else {
      water_timer_el.textContent = `${remaining}s`;
    }
  }, 1000);
});

// -- Sun button --
// Click to start a sunlight boost: water drains at half rate for
// sun_boost_duration, then the button goes on cooldown for sun_cooldown.
sun_btn.addEventListener("click", () => {
  if (sun_on_cooldown || sun_boost_active) return;
  startSunBoost();
});

function startSunBoost() {
  sun_boost_active = true;
  skip_next_drain = false;
  sun_btn.disabled = true;
  sun_btn.style.opacity = 0.7;
  updateUI(); // turn the glow on immediately, don't wait for the next drain tick

  let remaining = sun_boost_duration / 1000;
  sun_timer_el.textContent = `${remaining}s`;

  sun_boost_timer = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      clearInterval(sun_boost_timer);
      sun_boost_active = false;
      updateUI(); // turn the glow off right away
      startSunCooldown();
    } else {
      sun_timer_el.textContent = `${remaining}s`;
    }
  }, 1000);
}

function startSunCooldown() {
  sun_on_cooldown = true;
  let remaining = sun_cooldown / 1000;
  sun_timer_el.textContent = `${remaining}s`;

  sun_cooldown_timer = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      clearInterval(sun_cooldown_timer);
      sun_on_cooldown = false;
      sun_btn.disabled = false;
      sun_btn.style.opacity = 1;
      sun_timer_el.textContent = "READY";
    } else {
      sun_timer_el.textContent = `${remaining}s`;
    }
  }, 1000);
}

// -- Restart button --
restart_btn.addEventListener("click", () => {
  water_level = 100;

  water_on_cooldown = false;
  water_btn.disabled = false;
  water_btn.style.opacity = 1;
  water_timer_el.textContent = "READY";
  clearInterval(cooldown_timer);

  sun_boost_active = false;
  sun_on_cooldown = false;
  clearInterval(sun_boost_timer);
  clearInterval(sun_cooldown_timer);
  sun_btn.disabled = false;
  sun_btn.style.opacity = 1;
  sun_timer_el.textContent = "READY";

  lastNotifiedStage = null;

  updateUI();
});

updateUI();