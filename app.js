(function () {
  "use strict";

  const CITY_ORDER = ["asakusa", "ueno", "shinjuku", "ikebukuro", "shibuya"];
  const HIDDEN_GEM_KEYWORDS = ["空いて", "穴場", "並ばない", "混雑しにくい", "少ない", "ほぼ並ばない"];
  const NIGHT_SAFE_CATEGORIES = ["station", "convenience", "police", "government", "hospital"];
  const NIGHT_SAFE_KEYWORDS = ["夜も安心", "夜間安全", "明るい", "夜でも安心"];

  const state = {
    lang: localStorage.getItem("ttf_lang") || "ja",
    city: localStorage.getItem("ttf_city") || "asakusa",
    view: "browse", // 'browse' | 'ranking'
    activeTab: "home", // 'home' | 'map' | 'favorites'
    sortNearest: true,
    visibleCount: 8,
    category: "all",
    area: "all",
    rank: "all", // 'all' | 'S' | 'A' | 'B'
    only24h: false,
    wheelchairOnly: false,
    babyOnly: false,
    query: "",
    all: [],
    byCity: {},
    current: [],
    geo: null, // { lat, lng } once obtained, reused for distance display in list/ranking too
    deferredInstallPrompt: null,
    favorites: new Set(JSON.parse(localStorage.getItem("ttf_favorites") || "[]")),
    map: null,
    mapMarkersLayer: null,
  };

  const el = {
    cityBar: document.getElementById("cityBar"),
    langToggle: document.getElementById("langToggle"),
    menuBtn: document.getElementById("menuBtn"),
    sideMenu: document.getElementById("sideMenu"),
    sideMenuBackdrop: document.getElementById("sideMenuBackdrop"),
    sideMenuClose: document.getElementById("sideMenuClose"),
    searchToggleBtn: document.getElementById("searchToggleBtn"),
    nearMeBtn: document.getElementById("nearMeBtn"),
    nearMeLabel: document.getElementById("nearMeLabel"),
    filterSheet: document.getElementById("filterSheet"),
    filterSheetClose: document.getElementById("filterSheetClose"),
    openFilterSheet: document.getElementById("openFilterSheet"),
    openSponsorInfo: document.getElementById("openSponsorInfo"),
    sponsorInfoSheet: document.getElementById("sponsorInfoSheet"),
    sponsorInfoClose: document.getElementById("sponsorInfoClose"),
    sponsorDemoCard: document.getElementById("sponsorDemoCard"),
    sponsorInfoLinkLabel: document.getElementById("sponsorInfoLinkLabel"),
    sponsorInfoTitle: document.getElementById("sponsorInfoTitle"),
    sponsorInfoLead: document.getElementById("sponsorInfoLead"),
    sponsorInfoPricing: document.getElementById("sponsorInfoPricing"),
    sponsorDemoHeading: document.getElementById("sponsorDemoHeading"),
    sponsorInfoDisclaimer: document.getElementById("sponsorInfoDisclaimer"),
    sortNearest: document.getElementById("sortNearest"),
    sortNearestLabel: document.getElementById("sortNearestLabel"),
    mapSection: document.getElementById("mapSection"),
    leafletMapEl: document.getElementById("leafletMap"),
    showMoreBtn: document.getElementById("showMoreBtn"),
    showMoreLabel: document.getElementById("showMoreLabel"),
    tabHome: document.getElementById("tabHome"),
    tabMap: document.getElementById("tabMap"),
    tabFavorites: document.getElementById("tabFavorites"),
    tabRanking: document.getElementById("tabRanking"),
    headerTagline: document.getElementById("headerTagline"),
    emergencyBtn: document.getElementById("emergencyBtn"),
    emergencyLabel: document.getElementById("emergencyLabel"),
    emergencyHint: document.getElementById("emergencyHint"),
    emergencyResults: document.getElementById("emergencyResults"),
    sosPushLabel: document.getElementById("sosPushLabel"),
    sosDescLabel: document.getElementById("sosDescLabel"),
    sosNoteSmall: document.getElementById("sosNoteSmall"),
    searchInput: document.getElementById("searchInput"),
    areaSelect: document.getElementById("areaSelect"),
    viewBrowse: document.getElementById("viewBrowse"),
    viewRanking: document.getElementById("viewRanking"),
    filter24h: document.getElementById("filter24h"),
    filter24hLabel: document.getElementById("filter24hLabel"),
    filterWheelchair: document.getElementById("filterWheelchair"),
    filterWheelchairLabel: document.getElementById("filterWheelchairLabel"),
    openFilterSheetLabel: document.getElementById("openFilterSheetLabel"),
    sideMenuAreaHeading: document.getElementById("sideMenuAreaHeading"),
    viewRankingLabel: document.getElementById("viewRankingLabel"),
    filterSheetHeading: document.getElementById("filterSheetHeading"),
    tabHomeLabel: document.getElementById("tabHomeLabel"),
    tabMapLabel: document.getElementById("tabMapLabel"),
    tabFavoritesLabel: document.getElementById("tabFavoritesLabel"),
    tabRankingLabel: document.getElementById("tabRankingLabel"),
    filterBaby: document.getElementById("filterBaby"),
    rankChips: document.getElementById("rankChips"),
    categoryChips: document.getElementById("categoryChips"),
    resultMeta: document.getElementById("resultMeta"),
    listContainer: document.getElementById("listContainer"),
    detailSheet: document.getElementById("detailSheet"),
    detailContent: document.getElementById("detailContent"),
    detailClose: document.getElementById("detailClose"),
    footerNote: document.getElementById("footerNote"),
    offlineBanner: document.getElementById("offlineBanner"),
    installBanner: document.getElementById("installBanner"),
    installText: document.getElementById("installText"),
    installBtn: document.getElementById("installBtn"),
    installDismiss: document.getElementById("installDismiss"),
  };

  function saveFavorites() {
    localStorage.setItem("ttf_favorites", JSON.stringify(Array.from(state.favorites)));
  }

  function t() {
    return I18N[state.lang];
  }

  // Analytics hook stub: no external network calls are made from this function. It only
  // logs locally so the event names/shapes are ready to wire up to a real analytics
  // provider later, without changing any call sites when that happens.
  function trackEvent(name, detail) {
    try {
      console.log("[AI HUNTER event]", name, detail || {});
    } catch (e) {
      /* no-op */
    }
  }

  function haversine(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  function walkMinutes(meters) {
    return Math.max(1, Math.round(meters / 80));
  }

  function distanceOf(r) {
    if (!state.geo || !r.lat || !r.lng) return null;
    return haversine(state.geo.lat, state.geo.lng, r.lat, r.lng);
  }

  // Google Maps walking directions - resolved by name/address text, no API key required.
  function navUrl(r) {
    const dest = r.address ? `${r.name_ja} ${r.address}` : r.name_ja;
    return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}&travelmode=walking`;
  }

  function rankScore(rank) {
    if (!rank) return 0;
    if (rank.startsWith("S")) return 3;
    if (rank.startsWith("A")) return 2;
    if (rank.startsWith("B")) return 1;
    return 0;
  }

  function isHiddenGem(r) {
    if (!r.ai_hunter_memo) return false;
    return HIDDEN_GEM_KEYWORDS.some((kw) => r.ai_hunter_memo.includes(kw));
  }

  function isNightSafeHeuristic(r) {
    if (r.ai_hunter_memo && NIGHT_SAFE_KEYWORDS.some((kw) => r.ai_hunter_memo.includes(kw))) return true;
    return !!(r.is_24h && NIGHT_SAFE_CATEGORIES.includes(r.category));
  }

  // Composite score for the "God-tier ranking" view: rank first, then 24h, memo presence, accessibility.
  function godScore(r) {
    return (
      (r.isGodToilet ? 1000 : 0) +
      rankScore(r.emergency_rank) * 10 +
      (r.is_24h ? 3 : 0) +
      (r.ai_hunter_memo ? 2 : 0) +
      (isHiddenGem(r) ? 1 : 0) +
      (r.wheelchair === true ? 1 : 0) +
      (r.baby_bed === true || r.baby_chair === true ? 1 : 0)
    );
  }

  async function loadMaster() {
    // This build ships data_master.json flat at the repo root (see the delivered
    // ZIP layout) — fetch it directly. A previous version speculatively tried a
    // /data/ subfolder first, which could silently load a stale duplicate if one
    // existed there; that lookup has been removed to guarantee the shipped file wins.
    try {
      const res = await fetch("data_master.json", { cache: "no-store" });
      state.all = res.ok ? await res.json() : [];
    } catch (e) {
      state.all = [];
      console.error("TOKYO TOILET FINDER: failed to load data_master.json", e);
    }
    state.byCity = {};
    state.all.forEach((r) => {
      if (!state.byCity[r.city]) state.byCity[r.city] = [];
      state.byCity[r.city].push(r);
    });
  }

  function renderCityBar() {
    el.cityBar.innerHTML = "";
    CITY_ORDER.forEach((city) => {
      const btn = document.createElement("button");
      btn.className = "city-btn";
      btn.type = "button";
      btn.dataset.active = String(city === state.city);
      const count = (state.byCity[city] || []).length;
      btn.innerHTML = `${t().cities[city]}<span class="count">${count}</span>`;
      btn.addEventListener("click", () => switchCity(city));
      el.cityBar.appendChild(btn);
    });
  }

  function switchCity(city) {
    state.city = city;
    localStorage.setItem("ttf_city", city);
    trackEvent("search_executed", { city });
    state.category = "all";
    state.area = "all";
    state.rank = "all";
    state.only24h = false;
    state.wheelchairOnly = false;
    state.babyOnly = false;
    state.visibleCount = 8;
    el.filter24h.dataset.active = "false";
    el.filterWheelchair.dataset.active = "false";
    el.filterBaby.dataset.active = "false";
    el.emergencyResults.classList.add("hidden");
    el.emergencyResults.innerHTML = "";
    renderCityBar();
    state.current = state.byCity[city] || [];
    renderAreaSelect();
    renderRankChips();
    renderCategoryChips();
    renderMain();
    closeSideMenu();
  }

  function categoryLabel(cat) {
    return t().categories[cat] || cat;
  }

  function renderAreaSelect() {
    const areas = Array.from(new Set(state.current.map((r) => r.area_tag).filter(Boolean)));
    el.areaSelect.innerHTML = "";
    const allOpt = document.createElement("option");
    allOpt.value = "all";
    allOpt.textContent = t().areaAll;
    el.areaSelect.appendChild(allOpt);
    areas.forEach((a) => {
      const opt = document.createElement("option");
      opt.value = a;
      opt.textContent = a;
      el.areaSelect.appendChild(opt);
    });
    el.areaSelect.value = state.area;
  }

  function renderRankChips() {
    const T = t();
    el.rankChips.innerHTML = "";
    const ranks = [
      { key: "all", label: T.rankAll },
      { key: "S", label: "🏆 S" },
      { key: "A", label: "A" },
      { key: "B", label: "B" },
    ];
    ranks.forEach(({ key, label }) => {
      const chip = document.createElement("button");
      chip.className = "chip";
      chip.type = "button";
      chip.dataset.rank = key;
      chip.dataset.active = String(state.rank === key);
      chip.textContent = label;
      chip.addEventListener("click", () => {
        state.rank = key;
        renderRankChips();
        renderMain();
      });
      el.rankChips.appendChild(chip);
    });
  }

  function renderCategoryChips() {
    const counts = {};
    state.current.forEach((r) => {
      counts[r.category] = (counts[r.category] || 0) + 1;
    });
    const cats = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
    el.categoryChips.innerHTML = "";

    const allChip = document.createElement("button");
    allChip.className = "chip";
    allChip.type = "button";
    allChip.dataset.active = String(state.category === "all");
    allChip.textContent = (state.lang === "ja" ? "すべて" : "All") + ` (${state.current.length})`;
    allChip.addEventListener("click", () => {
      state.category = "all";
      renderCategoryChips();
      renderMain();
    });
    el.categoryChips.appendChild(allChip);

    cats.forEach((cat) => {
      const chip = document.createElement("button");
      chip.className = "chip";
      chip.type = "button";
      chip.dataset.active = String(state.category === cat);
      chip.textContent = `${categoryLabel(cat)} (${counts[cat]})`;
      chip.addEventListener("click", () => {
        state.category = cat;
        renderCategoryChips();
        renderMain();
      });
      el.categoryChips.appendChild(chip);
    });
  }

  function matchesFilters(r) {
    if (state.activeTab === "favorites" && !state.favorites.has(r.id)) return false;
    if (state.category !== "all" && r.category !== state.category) return false;
    if (state.area !== "all" && r.area_tag !== state.area) return false;
    if (state.only24h && !r.is_24h) return false;
    if (state.wheelchairOnly && r.wheelchair !== true) return false;
    if (state.babyOnly && !(r.baby_bed === true || r.baby_chair === true)) return false;
    if (state.rank !== "all") {
      if (!r.emergency_rank || !r.emergency_rank.startsWith(state.rank)) return false;
    }
    if (state.query) {
      const q = state.query.toLowerCase();
      const haystack = [r.name_ja, r.name_en, r.area_tag, r.address].filter(Boolean).join(" ").toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  }

  function sortForDisplay(items) {
    const withMeta = items.map((r) => ({ r, dist: distanceOf(r) }));
    withMeta.sort((a, b) => {
      // 0. PREMIUM sponsor placements may surface first in area results (clearly badged as
      //    sponsored - see the god-badge/sponsor-badge markup; never silently blended in).
      const premiumDiff = (b.r.sponsorTier === "premium" ? 1 : 0) - (a.r.sponsorTier === "premium" ? 1 : 0);
      if (premiumDiff !== 0) return premiumDiff;
      // 1. AI HUNTER-certified "god toilets" always float to the top.
      const godDiff = (b.r.isGodToilet ? 1 : 0) - (a.r.isGodToilet ? 1 : 0);
      if (godDiff !== 0) return godDiff;
      // 2. Distance (only meaningful while "近い順" is active and we have a fix).
      if (state.sortNearest && (a.dist != null || b.dist != null)) {
        if (a.dist == null) return 1;
        if (b.dist == null) return -1;
        if (a.dist !== b.dist) return a.dist - b.dist;
      }
      // 3. SOS-ready venues (already carry an emergency rank) come next.
      const rankDiff = rankScore(b.r.emergency_rank) - rankScore(a.r.emergency_rank);
      if (rankDiff !== 0) return rankDiff;
      // 4. Everything else keeps its original relative order.
      return 0;
    });
    return withMeta;
  }

  function displayName(r) {
    if (state.lang === "en" && r.name_en) return r.name_en;
    return r.name_ja;
  }

  function categoryIcon(cat) {
    const map = {
      convenience: "🏪", station: "🚉", commercial: "🏬", dept_commercial: "🏬",
      park: "🌳", hospital: "🏥", police: "🚓", government: "🏛️",
      shrine_temple: "⛩️", hotel: "🏨", restaurant: "🍽️", cafe: "☕",
      pachinko: "🎰", bath_gym: "♨️", supermarket: "🛒", shop: "🛍️",
      building: "🏢", unknown: "❓", unusable: "🚫", unknown_conflict: "⚠️",
      theater: "🎭", school: "🏫", museum: "🖼️",
    };
    return map[cat] || "🚻";
  }

  function photoHtmlSmall(r) {
    if (r.photo_url) {
      return `<img class="card__photo" src="${r.photo_url}" alt="">`;
    }
    return `<div class="card__photo-placeholder">${categoryIcon(r.category)}</div>`;
  }

  function extraTagsHtml(r) {
    const T = t();
    const tags = [];
    if (r.emergency_rank) tags.push(`<span class="tag tag--rank">${r.emergency_rank.replace("（ユーザー指定）", "")}</span>`);
    if (r.isSOS === true) tags.push(`<span class="tag tag--sos">🚨 ${T.sosCandidateTag}</span>`);
    if (r.is_24h) tags.push(`<span class="tag tag--24h">24h</span>`);
    if (r.wheelchair === true) tags.push(`<span class="tag tag--24h">♿</span>`);
    if (r.paper === true) tags.push(`<span class="tag tag--24h">🧻 ${T.paperTag}</span>`);
    if (r.washlet === true) tags.push(`<span class="tag tag--24h">🚿 ${T.washletTag}</span>`);
    if (r.baby_bed === true || r.baby_chair === true) tags.push(`<span class="tag tag--24h">👶</span>`);
    if (isHiddenGem(r)) tags.push(`<span class="tag tag--hidden-gem">${T.hiddenGemTag}</span>`);
    if (isNightSafeHeuristic(r)) tags.push(`<span class="tag tag--night-safe">${T.nightSafeTag}</span>`);
    if (r.category === "unusable") tags.push(`<span class="tag tag--unusable">${categoryLabel("unusable")}</span>`);
    return tags.join("");
  }

  function renderMain() {
    if (state.view === "ranking") {
      renderRanking();
      updateMap([]);
    } else {
      renderList();
    }
  }

  function renderList() {
    if (state.current.length === 0) {
      el.resultMeta.textContent = "";
      el.listContainer.innerHTML = `<div class="empty-state">${t().comingSoon}</div>`;
      el.showMoreBtn.classList.add("hidden");
      updateMap([]);
      return;
    }
    const filtered = state.current.filter(matchesFilters);

    if (filtered.length === 0) {
      el.resultMeta.textContent = t().resultCount(0);
      const usingEquipmentFilter = state.wheelchairOnly || state.babyOnly;
      el.listContainer.innerHTML = `<div class="empty-state">${
        state.activeTab === "favorites" ? t().favoritesEmpty : usingEquipmentFilter ? t().emptyStateFilter : t().emptyState
      }</div>`;
      el.showMoreBtn.classList.add("hidden");
      updateMap([]);
      return;
    }

    const sorted = sortForDisplay(filtered);
    el.resultMeta.textContent = t().resultCount(sorted.length);

    const visible = sorted.slice(0, state.visibleCount);
    const frag = document.createDocumentFragment();
    visible.forEach((entry, idx) =>
      frag.appendChild(
        entry.r.sponsorTier === "premium" ? renderPremiumCard(entry.r, idx + 1) : renderCard(entry.r, entry.dist, idx + 1)
      )
    );
    el.listContainer.innerHTML = "";
    el.listContainer.appendChild(frag);

    el.showMoreBtn.classList.toggle("hidden", sorted.length <= visible.length);
    updateMap(visible.map((v) => v.r));
  }

  function typeBadgeClass(category) {
    if (category === "dept_commercial" || category === "commercial") return "type-badge--dept";
    if (category === "station") return "type-badge--station";
    if (category === "park") return "type-badge--park";
    if (category === "government") return "type-badge--gov";
    return "type-badge--other";
  }

  // Cleanliness word: prefers the canonical `cleanLevel` string field (きれい/普通/汚い),
  // set only by real verification - never inferred. No current data sets this yet.
  function cleanlinessLabel(r) {
    return r.cleanLevel || null;
  }

  // Confirmed-only detail tags - shown on EVERY card (not just god-toilets), and only for
  // the specific sub-fields a given record actually has. Nothing here is AI-guessed; a
  // null/absent field simply produces no tag rather than a placeholder or inferred value.
  // `emphasize` (used for isGodToilet cards) only changes the visual styling, never the
  // underlying data shown.
  function detailExtrasHtml(r, emphasize) {
    const parts = [];
    if (r.entrySeconds != null) parts.push(`🚪 ${t().entranceLabel}${r.entrySeconds}${t().secondsUnit}`);
    if (r.insideSeconds != null) parts.push(`🏢 ${t().insideLabel}${r.insideSeconds}${t().secondsUnit}`);
    if (r.entranceHint) parts.push(`📍 ${r.entranceHint}`);
    if (r.toiletType) parts.push(`🚽 ${r.toiletType}`);
    const clean = cleanlinessLabel(r);
    if (clean) parts.push(`✨ ${clean}`);
    if (r.parking) parts.push(`🚗 ${r.parking}`);
    if (r.womenCrowd) parts.push(`👩 ${r.womenCrowd}`);
    if (parts.length === 0) return "";
    const cls = emphasize ? "god-extra god-extra--emphasize" : "god-extra";
    return `<div class="${cls}">${parts.map((p) => `<span class="god-extra__item">${p}</span>`).join("")}</div>`;
  }

  function sponsorCardClass(r) {
    if (r.sponsorTier === "premium") return "card--premium";
    if (r.sponsorTier === "partner") return "card--partner";
    return "";
  }

  // PREMIUM sponsor cards get a distinct, larger layout (crown header, big photo, store's
  // own intro/PR text, featured product, social links). Nothing renders unless a real
  // sponsor record sets these fields - there is no demo/fake data wired in here.
  function renderPremiumCard(r, number) {
    const card = document.createElement("div");
    card.className = "card card--premium";
    const photoHtml = r.photo_url
      ? `<img class="premium-card__photo" src="${r.photo_url}" alt="">`
      : `<div class="premium-card__photo premium-card__photo--placeholder">${categoryIcon(r.category)}</div>`;
    const socialLinks = [];
    if (r.storeMapUrl) socialLinks.push(`<a href="${r.storeMapUrl}" target="_blank" rel="noopener">${t().goShort}</a>`);
    if (r.storeInstagram) socialLinks.push(`<a href="${r.storeInstagram}" target="_blank" rel="noopener">Instagram</a>`);
    if (r.storeX) socialLinks.push(`<a href="${r.storeX}" target="_blank" rel="noopener">X</a>`);
    card.innerHTML = `
      <div class="premium-card__header">👑 ${t().sponsorPremium} ${r.premiumNo ? `No.${r.premiumNo}` : ""} ${r.isGodToilet ? `｜👑 ${t().godBadgeText}` : ""}</div>
      ${photoHtml}
      <div class="premium-card__body">
        <div class="premium-card__name">${displayName(r)}</div>
        ${r.storeIntro ? `<div class="premium-card__intro">${r.storeIntro}</div>` : ""}
        ${r.storePR ? `<div class="premium-card__pr">${r.storePR}</div>` : ""}
        ${r.featuredProduct ? `<div class="premium-card__product">🌟 ${r.featuredProduct}</div>` : ""}
        <div class="card__meta">${extraTagsHtml(r)}</div>
        ${socialLinks.length ? `<div class="premium-card__links">${socialLinks.join("")}</div>` : ""}
      </div>
      <a class="card__go" href="${navUrl(r)}" target="_blank" rel="noopener">📍 ${t().goShort}</a>
    `;
    card.querySelector(".card__go").addEventListener("click", (e) => {
      e.stopPropagation();
      trackEvent("sponsor_cta_click", { id: r.id, tier: "premium" });
    });
    card.addEventListener("click", () => openDetail(r));
    return card;
  }

  function renderCard(r, dist, number, opts) {
    const showTypeBadge = opts && opts.showTypeBadge;
    const card = document.createElement("div");
    const isGod = r.isGodToilet === true;
    card.className = ["card", isGod ? "godcard" : "", sponsorCardClass(r)].filter(Boolean).join(" ");
    const distLabel = dist != null ? ` ｜ 🚶 徒歩${walkMinutes(dist)}分（${Math.round(dist)}m）` : "";
    const isFav = state.favorites.has(r.id);
    const typeBadgeHtml = showTypeBadge
      ? `<span class="type-badge ${typeBadgeClass(r.category)}">${buildingTypeLabel(r.category)}</span>`
      : "";
    const secondLine = r.address || r.area_tag || "";
    const godBadgeHtml = isGod ? `<div class="god-badge">👑 ${t().godBadgeText}</div>` : "";
    const sponsorBadgeHtml =
      r.sponsorTier === "premium"
        ? `<div class="sponsor-badge sponsor-badge--premium">${t().sponsorPremium}</div>`
        : r.sponsorTier === "partner"
        ? `<div class="sponsor-badge sponsor-badge--partner">${t().sponsorPartner}</div>`
        : "";
    const partnerExtraHtml =
      r.sponsorTier === "partner"
        ? `<div class="partner-extra">
            ${r.storeIntro ? `<div class="partner-extra__intro">${r.storeIntro}</div>` : ""}
            ${r.storePR ? `<div class="partner-extra__pr">${r.storePR}</div>` : ""}
            ${r.featuredProduct ? `<div class="partner-extra__product">🌟 ${r.featuredProduct}</div>` : ""}
          </div>`
        : "";
    card.innerHTML = `
      ${godBadgeHtml}
      ${sponsorBadgeHtml}
      <div class="card__badge">${number}</div>
      ${photoHtmlSmall(r)}
      <div class="card__body">
        <div class="card__top">
          <div class="card__name">${displayName(r)}</div>
          <button class="card__fav" type="button" aria-label="favorite">${isFav ? "★" : "☆"}</button>
        </div>
        ${typeBadgeHtml}
        <div class="card__area">${secondLine}</div>
        <div class="card__meta">
          <span>${(r.open_hours || "-")}${distLabel}</span>
          ${extraTagsHtml(r)}
        </div>
        ${detailExtrasHtml(r, isGod)}
        ${partnerExtraHtml}
      </div>
      <a class="card__go" href="${navUrl(r)}" target="_blank" rel="noopener">📍 ${t().goShort}</a>
    `;
    card.querySelector(".card__fav").addEventListener("click", (e) => {
      e.stopPropagation();
      toggleFavorite(r.id);
      card.querySelector(".card__fav").textContent = state.favorites.has(r.id) ? "★" : "☆";
      if (state.activeTab === "favorites") renderList();
    });
    card.querySelector(".card__go").addEventListener("click", (e) => {
      e.stopPropagation();
      trackEvent("map_click", { id: r.id, source: "list" });
    });
    card.addEventListener("click", () => openDetail(r));
    return card;
  }

  function toggleFavorite(id) {
    if (state.favorites.has(id)) state.favorites.delete(id);
    else state.favorites.add(id);
    saveFavorites();
  }

  // --- Leaflet map (OpenStreetMap tiles, no API key required) ---
  function initMap() {
    if (state.map || typeof L === "undefined") return;
    state.map = L.map(el.leafletMapEl, { zoomControl: false, attributionControl: true }).setView([35.6895, 139.6917], 14);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(state.map);
    L.control.zoom({ position: "bottomright" }).addTo(state.map);
    state.mapMarkersLayer = L.layerGroup().addTo(state.map);
  }

  function numberedPinIcon(n) {
    return L.divIcon({
      className: "",
      html: `<div class="pin-marker pin-marker--numbered"><span>${n}</span></div>`,
      iconSize: [34, 34],
      iconAnchor: [17, 32],
    });
  }

  function meMarkerIcon() {
    return L.divIcon({
      className: "",
      html: `<div class="pin-marker pin-marker--me"></div>`,
      iconSize: [18, 18],
      iconAnchor: [9, 9],
    });
  }

  function updateMap(items) {
    if (typeof L === "undefined") return;
    if (!state.map) initMap();
    if (!state.map) return;
    state.mapMarkersLayer.clearLayers();

    const bounds = [];
    if (state.geo) {
      L.marker([state.geo.lat, state.geo.lng], { icon: meMarkerIcon(), zIndexOffset: 1000 })
        .addTo(state.mapMarkersLayer);
      bounds.push([state.geo.lat, state.geo.lng]);
    }
    items.forEach((r, idx) => {
      if (!r.lat || !r.lng) return;
      const marker = L.marker([r.lat, r.lng], { icon: numberedPinIcon(idx + 1) }).addTo(state.mapMarkersLayer);
      marker.bindPopup(`<strong>${displayName(r)}</strong><br>${r.open_hours || ""}`);
      marker.on("click", () => openDetail(r));
      bounds.push([r.lat, r.lng]);
    });

    if (bounds.length > 0) {
      if (bounds.length === 1) {
        state.map.setView(bounds[0], 16);
      } else {
        state.map.fitBounds(bounds, { padding: [30, 30], maxZoom: 16 });
      }
    }
    // Leaflet needs a nudge after being shown inside an initially-hidden/resized container.
    setTimeout(() => state.map && state.map.invalidateSize(), 60);
  }

  function renderRanking() {
    const T = t();
    const pool = state.current.filter((r) => r.category !== "unusable");
    if (pool.length === 0) {
      el.resultMeta.textContent = "";
      el.listContainer.innerHTML = `<div class="empty-state">${T.rankingEmpty}</div>`;
      return;
    }
    const ranked = [...pool].sort((a, b) => godScore(b) - godScore(a)).slice(0, 15);
    el.resultMeta.textContent = t().resultCount(ranked.length);

    const frag = document.createDocumentFragment();
    const note = document.createElement("div");
    note.className = "ranking-note";
    note.textContent = T.rankingNote;
    frag.appendChild(note);

    ranked.forEach((r, idx) => {
      const row = document.createElement("div");
      row.className = "rank-card" + (r.isGodToilet ? " rank-card--god" : "");
      const medalClass = idx === 0 ? " rank-medal--1" : idx === 1 ? " rank-medal--2" : idx === 2 ? " rank-medal--3" : "";

      const detailRows = [];
      detailRows.push(
        `<div class="rank-detail__row"><span class="rank-detail__label">${T.rankSLabel}</span><span>${r.emergency_rank || T.rankNoData}</span></div>`
      );
      detailRows.push(
        `<div class="rank-detail__row"><span class="rank-detail__label">${T.rankEntranceLabel}</span><span>${
          r.entrance_seconds != null ? `${r.entrance_seconds}${T.secondsUnit}` : T.rankNoData
        }</span></div>`
      );
      detailRows.push(
        `<div class="rank-detail__row"><span class="rank-detail__label">${T.rankCongestionLabel}</span><span>${
          r.women_congestion_note || T.rankNoData
        }</span></div>`
      );
      detailRows.push(
        `<div class="rank-detail__row"><span class="rank-detail__label">${T.rankTestimonialLabel}</span><span>${
          r.user_field_note || T.rankNoTestimonial
        }</span></div>`
      );

      row.innerHTML = `
        <div class="rank-medal${medalClass}">${idx + 1}</div>
        ${photoHtmlSmall(r)}
        <div class="card__body">
          <div class="rank-card__name">${r.isGodToilet ? "🏆 " : ""}${displayName(r)}</div>
          <div class="rank-card__meta">${(r.open_hours || "-")}</div>
          <div class="card__meta">${extraTagsHtml(r)}</div>
          <div class="rank-detail">${detailRows.join("")}</div>
        </div>
      `;
      row.addEventListener("click", () => openDetail(r));
      frag.appendChild(row);
    });
    el.listContainer.innerHTML = "";
    el.listContainer.appendChild(frag);
  }

  const QUICK_REPORT_TAGS = ["clean", "quickEntry", "hadPaper", "crowded", "closed", "entranceHere"];

  function loadReports(id) {
    try {
      const all = JSON.parse(localStorage.getItem("ttf_reports") || "{}");
      return all[id] || [];
    } catch (e) {
      return [];
    }
  }

  function saveReport(id, tag) {
    let all = {};
    try {
      all = JSON.parse(localStorage.getItem("ttf_reports") || "{}");
    } catch (e) {
      all = {};
    }
    if (!all[id]) all[id] = [];
    all[id].push({ tag, ts: new Date().toISOString() });
    localStorage.setItem("ttf_reports", JSON.stringify(all));
  }

  function quickReportHtml(r) {
    const T = t();
    const buttons = QUICK_REPORT_TAGS.map((tag) => `<button class="quick-report__btn" type="button" data-tag="${tag}">${T.quickReportTags[tag]}</button>`).join("");
    const counts = loadReports(r.id);
    return `
      <div class="quick-report">
        <div class="quick-report__title">${T.quickReportTitle}</div>
        <div class="quick-report__note">${T.quickReportLocalNote}</div>
        <div class="quick-report__buttons">${buttons}</div>
        <div class="quick-report__count" id="quickReportCount">${T.quickReportSavedCount(counts.length)}</div>
      </div>
    `;
  }

  function openDetail(r) {
    const T = t();
    trackEvent("card_view", { id: r.id, city: r.city });
    const rows = [];
    rows.push([T.detailCategory, categoryLabel(r.category)]);
    rows.push([T.detailHours, r.open_hours || "-"]);
    if (r.nearest_station) rows.push([T.detailStation, r.nearest_station]);
    if (r.address) rows.push([T.detailAddress, r.address]);
    if (r.emergency_rank) rows.push([T.detailRank, r.emergency_rank]);
    if (r.source) rows.push([T.detailSource, r.source]);
    if (r.verifiedAt) rows.push([T.detailVerifiedAt, r.verifiedAt]);
    if (r.sourceType) rows.push([T.detailSourceType, r.sourceType]);
    const dist = distanceOf(r);
    if (dist != null) rows.push([state.lang === "ja" ? "現在地から" : "From you", `${Math.round(dist)}m / ${walkMinutes(dist)} min`]);

    const rowsHtml = rows
      .map(([label, val]) => `<div class="detail-row"><div class="detail-row__label">${label}</div><div>${val}</div></div>`)
      .join("");

    const photoHtml = r.photo_url
      ? `<img class="photo-img" src="${r.photo_url}" alt="${displayName(r)}">`
      : `<div class="photo-placeholder">${T.noPhoto}</div>`;

    const badges = extraTagsHtml(r);

    el.detailContent.innerHTML = `
      <div class="detail-name">${displayName(r)}</div>
      ${r.name_en && state.lang === "ja" ? `<div class="detail-name-en">${r.name_en}</div>` : ""}
      ${photoHtml}
      <div class="card__meta" style="margin-bottom:10px;">${badges}</div>
      ${rowsHtml}
      ${detailExtrasHtml(r, r.isGodToilet === true)}
      <div class="detail-memo">
        <strong>${T.detailMemoTitle}</strong><br>
        ${r.ai_hunter_memo || T.noMemo}
      </div>
      <div class="detail-memo detail-memo--user">
        <strong>${T.detailUserTitle}</strong><br>
        ${r.user_field_note || T.noUserNote}
      </div>
      ${quickReportHtml(r)}
      <p style="font-size:11px;color:var(--ink-soft);margin-top:8px;">${T.heuristicNote}</p>
      <a class="detail-go" href="${navUrl(r)}" target="_blank" rel="noopener">${T.goWalk}</a>
    `;
    el.detailContent.querySelectorAll(".quick-report__btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        saveReport(r.id, btn.dataset.tag);
        btn.classList.add("quick-report__btn--done");
        const countEl = document.getElementById("quickReportCount");
        if (countEl) countEl.textContent = T.quickReportSavedCount(loadReports(r.id).length);
      });
    });
    el.detailContent.querySelector(".detail-go").addEventListener("click", () => {
      trackEvent("map_click", { id: r.id, source: "detail" });
    });
    el.detailSheet.classList.remove("hidden");
  }

  function closeDetail() {
    el.detailSheet.classList.add("hidden");
  }

  // --- SOS: vibration + flash + geolocation + prioritized emergency-ready list ---
  function walkTimeLabel(meters) {
    const seconds = Math.round((meters / 80) * 60);
    if (seconds < 60) return `徒歩${Math.max(5, seconds)}秒`;
    return `徒歩${Math.max(1, Math.round(seconds / 60))}分`;
  }

  function safeVibrate() {
    try {
      if (navigator.vibrate) navigator.vibrate([120, 80, 120]);
    } catch (e) {
      /* unsupported device: no-op */
    }
  }

  function playSosFlash() {
    el.emergencyBtn.classList.remove("is-triggered");
    // force reflow so the animation can restart on repeated taps
    void el.emergencyBtn.offsetWidth;
    el.emergencyBtn.classList.add("is-triggered");
    setTimeout(() => el.emergencyBtn.classList.remove("is-triggered"), 850);
  }

  function showSosStatus(text, isError) {
    el.emergencyResults.classList.remove("hidden");
    el.emergencyResults.innerHTML = `<div class="sos-status${isError ? " sos-status--error" : ""}">${text}</div>`;
  }

  // Emergency priority: an explicit `isSOS` flag (manually verified, never AI-guessed) always
  // wins; otherwise we fall back to a category heuristic - dept stores/commercial > stations >
  // parks > public facilities. Convenience stores and venues with unclear usage conditions are
  // pushed to the bottom (they still show up in the normal browse list, just not favored here).
  function sosPriority(r) {
    if (r.isSOS === true) return 0;
    const category = r.category;
    if (category === "dept_commercial" || category === "commercial") return 1;
    if (category === "station") return 2;
    if (category === "park") return 3;
    if (category === "government") return 4;
    if (category === "convenience" || category === "unknown" || category === "unknown_conflict") return 9;
    return 6;
  }

  function buildingTypeLabel(category) {
    const T = t();
    if (category === "dept_commercial" || category === "commercial") return T.buildingTypeDept;
    if (category === "station") return T.buildingTypeStation;
    if (category === "park") return T.buildingTypePark;
    if (category === "government") return T.buildingTypeGov;
    return categoryLabel(category);
  }

  function triggerSOS() {
    safeVibrate();
    playSosFlash();
    showSosStatus(t().sosSearching);
    trackEvent("sos_used", { city: state.city });

    // Search the ENTIRE dataset (all cities), not just the currently selected city tab,
    // since emergency-ready venues near the user's real GPS position may be outside the active tab.
    const basePool = state.all.filter((r) => r.category !== "unusable");
    if (basePool.length === 0) {
      showSosStatus(t().emergencyNoData, true);
      return;
    }

    // Evaluation order once we have a real GPS fix: (1) within ~3km, preferring a tight
    // ~500m band, (2) SOS suitability (explicit isSOS flag, else category heuristic),
    // (3) actual distance. A nearby station/public toilet must never lose to a department
    // store that is merely "the right category" but several km away - so distance banding
    // is checked BEFORE category priority, not after.
    const NEAR_BAND_M = 500;
    const MAX_RADIUS_M = 3000;
    function distanceBand(distMeters) {
      if (distMeters <= NEAR_BAND_M) return 0;
      if (distMeters <= MAX_RADIUS_M) return 1;
      return 2;
    }

    const finishWithGeo = () => {
      // Only venues with real, verified coordinates can be evaluated for proximity - venues
      // without coordinates are excluded here rather than shown with a guessed distance.
      const withCoords = basePool
        .filter((r) => r.lat && r.lng)
        .map((r) => ({ r, dist: distanceOf(r) }));

      let pool = withCoords.filter((x) => x.dist <= MAX_RADIUS_M);
      if (pool.length === 0) {
        // Nothing within 3km - fall back to whatever geocoded venues exist at all,
        // still ranked nearest-first, rather than showing an unhelpful empty result.
        pool = withCoords;
      }

      pool.sort((a, b) => {
        const bandDiff = distanceBand(a.dist) - distanceBand(b.dist);
        if (bandDiff !== 0) return bandDiff;
        const pd = sosPriority(a.r) - sosPriority(b.r);
        if (pd !== 0) return pd;
        return a.dist - b.dist;
      });

      renderSosList(pool.slice(0, 8));
    };

    // No GPS fix available: we cannot evaluate real distance at all, so we fall back to
    // SOS suitability only, and the card renderer will not display any distance/walk-time
    // claim for these (see renderSosCard - it only shows a time when `dist` is a real number).
    const finishWithoutGeo = () => {
      const withMeta = basePool.map((r) => ({ r, dist: null }));
      withMeta.sort((a, b) => {
        const pd = sosPriority(a.r) - sosPriority(b.r);
        if (pd !== 0) return pd;
        return rankScore(b.r.emergency_rank) - rankScore(a.r.emergency_rank);
      });
      renderSosList(withMeta.slice(0, 8));
    };

    if (!navigator.geolocation) {
      finishWithoutGeo();
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        state.geo = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        finishWithGeo();
      },
      () => finishWithoutGeo(),
      { timeout: 8000, enableHighAccuracy: true }
    );
  }

  function approxWalkPhrase(meters) {
    const seconds = Math.round((meters / 80) * 60);
    if (seconds < 60) return `${t().walkApprox}${Math.max(5, seconds)}${t().secondsUnit}`;
    return `${t().walkApprox}${Math.max(1, Math.round(seconds / 60))}${t().minutesUnit}`;
  }

  // Short, reassuring SOS card - deliberately minimal per spec (name, why it's suggested,
  // an approximate walk time only when we actually have one, and a single action button).
  // Never implies the venue has agreed to help or that toilet-only entry is guaranteed.
  function renderSosCard(r, dist) {
    const card = document.createElement("div");
    card.className = "sos-mini-card";
    const reassure = dist != null ? `${t().sosReassurePrefix}${approxWalkPhrase(dist)}${t().sosReassureSuffix}` : "";
    card.innerHTML = `
      <span class="type-badge ${typeBadgeClass(r.category)}">${buildingTypeLabel(r.category)}</span>
      <div class="sos-mini-card__name">${displayName(r)}</div>
      ${reassure ? `<div class="sos-mini-card__reassure">${reassure}</div>` : ""}
      <a class="sos-mini-card__go" href="${navUrl(r)}" target="_blank" rel="noopener">📍 ${t().sosGoNowBtn}</a>
    `;
    card.querySelector("a").addEventListener("click", (e) => {
      e.stopPropagation();
      trackEvent("map_click", { id: r.id, source: "sos" });
    });
    card.addEventListener("click", (e) => {
      if (e.target.closest(".sos-mini-card__go")) return;
      openDetail(r);
    });
    return card;
  }

  function renderSosList(items) {
    const T = t();
    if (items.length === 0) {
      showSosStatus(T.sosEmptyList, true);
      return;
    }

    el.emergencyResults.innerHTML = `
      <div class="sos-banner-note">
        <div class="sos-banner-note__text">
          <div class="sos-banner-note__title">${T.sosBannerTitle}</div>
          <div class="sos-banner-note__sub">${T.sosBannerSub}</div>
        </div>
        <span class="sos-banner-note__pill">${T.sosOnlyPill}</span>
      </div>
      <button id="sosCloseBtn" class="sos-close-btn" type="button">${T.sosClose}</button>
      <div id="sosCardList"></div>
    `;

    const listEl = document.getElementById("sosCardList");
    items.forEach(({ r, dist }) => {
      listEl.appendChild(renderSosCard(r, dist));
    });

    document.getElementById("sosCloseBtn").addEventListener("click", closeSosResults);
  }

  function closeSosResults() {
    el.emergencyResults.classList.add("hidden");
    el.emergencyResults.innerHTML = "";
  }

  // --- PWA: install prompt + offline banner ---
  function setupPwaExtras() {
    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();
      state.deferredInstallPrompt = e;
      const alreadyStandalone =
        window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone;
      if (!alreadyStandalone) {
        el.installBanner.classList.remove("hidden");
      }
    });

    el.installBtn.addEventListener("click", async () => {
      if (!state.deferredInstallPrompt) return;
      state.deferredInstallPrompt.prompt();
      await state.deferredInstallPrompt.userChoice;
      state.deferredInstallPrompt = null;
      el.installBanner.classList.add("hidden");
    });

    el.installDismiss.addEventListener("click", () => {
      el.installBanner.classList.add("hidden");
    });

    window.addEventListener("appinstalled", () => {
      el.installBanner.classList.add("hidden");
    });

    function updateOnlineStatus() {
      el.offlineBanner.classList.toggle("hidden", navigator.onLine);
    }
    window.addEventListener("online", updateOnlineStatus);
    window.addEventListener("offline", updateOnlineStatus);
    updateOnlineStatus();
  }

  function applyLangToStaticUI() {
    const T = t();
    el.headerTagline.textContent = T.headerTagline;
    el.emergencyLabel.textContent = T.emergencyLabel;
    el.emergencyHint.textContent = T.emergencyHint;
    el.sosPushLabel.textContent = T.sosPushLabel;
    el.sosDescLabel.textContent = T.sosDescLabel;
    el.sosNoteSmall.textContent = T.sosNoteSmall;
    el.nearMeLabel.textContent = T.nearMeLabel;
    el.sortNearestLabel.textContent = T.sortNearestLabel;
    el.searchInput.placeholder = T.searchPlaceholder;
    el.filter24hLabel.textContent = T.filter24h;
    el.filterWheelchairLabel.textContent = T.filterWheelchair;
    el.openFilterSheetLabel.textContent = T.openFilterSheet;
    el.sideMenuAreaHeading.textContent = T.sideMenuAreaHeading;
    el.viewRankingLabel.textContent = T.viewRanking;
    el.filterSheetHeading.textContent = T.openFilterSheet;
    el.filterBaby.textContent = "👶 " + T.filterBaby;
    el.viewBrowse.textContent = T.viewBrowse;
    el.viewRanking.textContent = T.viewRanking;
    el.showMoreLabel.textContent = T.showMore;
    el.tabHomeLabel.textContent = T.tabHome;
    el.tabMapLabel.textContent = T.tabMap;
    el.tabFavoritesLabel.textContent = T.tabFavorites;
    el.tabRankingLabel.textContent = T.tabRanking;
    el.sponsorInfoLinkLabel.textContent = T.sponsorInfoLinkLabel;
    el.sponsorInfoTitle.textContent = T.sponsorInfoTitle;
    el.sponsorInfoLead.textContent = T.sponsorInfoLead;
    el.sponsorInfoPricing.textContent = T.sponsorInfoPricing;
    el.sponsorDemoHeading.textContent = T.sponsorDemoHeading;
    el.sponsorInfoDisclaimer.textContent = T.sponsorInfoDisclaimer;
    el.footerNote.textContent = T.footerNote;
    el.installText.textContent = T.installText;
    el.installBtn.textContent = T.installBtn;
    el.offlineBanner.textContent = T.offlineBanner;
    el.langToggle.textContent = state.lang === "ja" ? "EN" : "日本語";
    document.documentElement.lang = state.lang;
  }

  function setActiveTab(tab) {
    state.activeTab = tab;
    el.tabHome.dataset.active = String(tab === "home");
    el.tabMap.dataset.active = String(tab === "map");
    el.tabFavorites.dataset.active = String(tab === "favorites");
    el.tabRanking.dataset.active = String(tab === "ranking");
  }

  function switchView(view) {
    state.view = view;
    el.viewBrowse.dataset.active = String(view === "browse");
    el.viewRanking.dataset.active = String(view === "ranking");
    setActiveTab(view === "ranking" ? "ranking" : "home");
    closeSideMenu();
    renderMain();
  }

  function openSideMenu() {
    el.sideMenu.classList.remove("hidden");
  }
  function closeSideMenu() {
    el.sideMenu.classList.add("hidden");
  }
  function openFilterSheetFn() {
    el.filterSheet.classList.remove("hidden");
  }
  function closeFilterSheetFn() {
    el.filterSheet.classList.add("hidden");
  }

  // Demo sponsor tiers/card shown in the "掲載・スポンサーについて" sheet. This is a fictional
  // sample record for layout purposes only - it is never merged into state.all / data_master.json
  // and no real venue is ever assigned a sponsor tier here.
  const SPONSOR_DEMO_RECORD = {
    id: "__sponsor_demo__",
    name_ja: "サンプル店舗（デモ）",
    name_en: "Sample Store (Demo)",
    city: "asakusa",
    area_tag: "デモ表示専用",
    category: "cafe",
    is_24h: false,
    open_hours: "10:00〜19:00（デモ）",
    address: "実在の住所ではありません",
    lat: null,
    lng: null,
    photo_url: null,
    isGodToilet: false,
    sponsorTier: "premium",
    premiumNo: "DEMO",
    storeIntro: "これはPREMIUM枠のレイアウト見本です。実在の契約店舗ではありません。",
    storePR: "店舗ご自身の言葉でPR文を掲載できます（掲載店舗の入力を想定）。",
    featuredProduct: "看板商品の例",
  };

  function populateSponsorInfoSheet() {
    const T = t();
    const listEl = (id, items) => {
      const ul = document.getElementById(id);
      ul.innerHTML = items.map((i) => `<li>${i}</li>`).join("");
    };
    listEl("sponsorPlanFreeList", T.sponsorPlanFree);
    listEl("sponsorPlanPartnerList", T.sponsorPlanPartner);
    listEl("sponsorPlanPremiumList", T.sponsorPlanPremium);
    el.sponsorDemoCard.innerHTML = "";
    el.sponsorDemoCard.appendChild(renderPremiumCard(SPONSOR_DEMO_RECORD, 0));
  }

  function openSponsorInfoFn() {
    closeSideMenu();
    populateSponsorInfoSheet();
    el.sponsorInfoSheet.classList.remove("hidden");
  }
  function closeSponsorInfoFn() {
    el.sponsorInfoSheet.classList.add("hidden");
  }

  function requestGeoOnce(onDone) {
    if (!navigator.geolocation) {
      onDone(false);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        state.geo = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        onDone(true);
      },
      () => onDone(false),
      { timeout: 8000, enableHighAccuracy: true }
    );
  }

  function bindEvents() {
    el.emergencyBtn.addEventListener("click", triggerSOS);

    el.menuBtn.addEventListener("click", openSideMenu);
    el.sideMenuClose.addEventListener("click", closeSideMenu);
    el.sideMenuBackdrop.addEventListener("click", closeSideMenu);

    el.searchToggleBtn.addEventListener("click", () => {
      openFilterSheetFn();
      setTimeout(() => el.searchInput.focus(), 50);
    });
    el.openFilterSheet.addEventListener("click", openFilterSheetFn);
    el.filterSheetClose.addEventListener("click", closeFilterSheetFn);
    el.filterSheet.addEventListener("click", (e) => {
      if (e.target === el.filterSheet) closeFilterSheetFn();
    });

    el.openSponsorInfo.addEventListener("click", openSponsorInfoFn);
    el.sponsorInfoClose.addEventListener("click", closeSponsorInfoFn);
    el.sponsorInfoSheet.addEventListener("click", (e) => {
      if (e.target === el.sponsorInfoSheet) closeSponsorInfoFn();
    });
    // The demo sponsor card is a static layout sample only - block all interaction on it so
    // it can never open a fake detail view, fire a fake map click, or log a fake event.
    el.sponsorDemoCard.addEventListener(
      "click",
      (e) => {
        e.preventDefault();
        e.stopImmediatePropagation();
      },
      true
    );

    el.nearMeBtn.addEventListener("click", () => {
      state.sortNearest = true;
      el.sortNearest.dataset.active = "true";
      requestGeoOnce(() => renderMain());
    });

    el.sortNearest.addEventListener("click", () => {
      state.sortNearest = !state.sortNearest;
      el.sortNearest.dataset.active = String(state.sortNearest);
      if (state.sortNearest && !state.geo) {
        requestGeoOnce(() => renderMain());
      } else {
        renderMain();
      }
    });

    el.searchInput.addEventListener("input", (e) => {
      state.query = e.target.value.trim();
      renderMain();
    });
    el.areaSelect.addEventListener("change", (e) => {
      state.area = e.target.value;
      renderMain();
    });
    el.viewBrowse.addEventListener("click", () => switchView("browse"));
    el.viewRanking.addEventListener("click", () => switchView("ranking"));
    el.filter24h.addEventListener("click", () => {
      state.only24h = !state.only24h;
      el.filter24h.dataset.active = String(state.only24h);
      renderMain();
    });
    el.filterWheelchair.addEventListener("click", () => {
      state.wheelchairOnly = !state.wheelchairOnly;
      el.filterWheelchair.dataset.active = String(state.wheelchairOnly);
      renderMain();
    });
    el.filterBaby.addEventListener("click", () => {
      state.babyOnly = !state.babyOnly;
      el.filterBaby.dataset.active = String(state.babyOnly);
      renderMain();
    });
    el.showMoreBtn.addEventListener("click", () => {
      state.visibleCount += 8;
      renderList();
    });

    function resetTransientOverlays() {
      closeSosResults();
      closeDetail();
      closeFilterSheetFn();
      closeSideMenu();
      closeSponsorInfoFn();
    }

    el.tabHome.addEventListener("click", () => {
      setActiveTab("home");
      state.view = "browse";
      el.mapSection.classList.remove("map-section--expanded");
      state.visibleCount = 8;
      resetTransientOverlays();
      renderMain();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
    el.tabMap.addEventListener("click", () => {
      setActiveTab("map");
      state.view = "browse";
      el.mapSection.classList.add("map-section--expanded");
      resetTransientOverlays();
      renderMain();
      el.mapSection.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    el.tabFavorites.addEventListener("click", () => {
      setActiveTab("favorites");
      state.view = "browse";
      el.mapSection.classList.remove("map-section--expanded");
      state.visibleCount = 8;
      resetTransientOverlays();
      renderMain();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
    el.tabRanking.addEventListener("click", () => {
      setActiveTab("ranking");
      state.view = "ranking";
      el.mapSection.classList.remove("map-section--expanded");
      resetTransientOverlays();
      renderMain();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });

    el.detailClose.addEventListener("click", closeDetail);
    el.detailSheet.addEventListener("click", (e) => {
      if (e.target === el.detailSheet) closeDetail();
    });
    el.langToggle.addEventListener("click", () => {
      state.lang = state.lang === "ja" ? "en" : "ja";
      localStorage.setItem("ttf_lang", state.lang);
      applyLangToStaticUI();
      renderCityBar();
      renderAreaSelect();
      renderRankChips();
      renderCategoryChips();
      renderMain();
    });
  }

  async function init() {
    applyLangToStaticUI();
    bindEvents();
    setupPwaExtras();
    await loadMaster();
    renderCityBar();
    state.current = state.byCity[state.city] || [];
    renderAreaSelect();
    renderRankChips();
    renderCategoryChips();
    renderMain();

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }
  }

  init();
})();
