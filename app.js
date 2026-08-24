// ============================================================
// 영수증 가계부 - app.js
// 로컬 저장 + Google Drive 자동 동기화 + 영수증 OCR 파싱
// ============================================================

const LOCAL_KEY = "receipt_budget_v1";
const LAST_SYNC_KEY = "receipt_budget_last_sync_v1";

let state = {
  transactions: [], // {id, date, store, item, category, amount, memo, createdAt, updatedAt}
};

let driveFileId = null;
let accessToken = null;
let tokenExpiresAt = 0;
let tokenClient = null;
let saveTimer = null;
let isSaving = false;
let pendingReviewData = null; // {date, store, items:[{name, amount, category}]}
let editingTxId = null;

// ------------------- 유틸 -------------------

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function formatWon(n) {
  return Math.round(n).toLocaleString("ko-KR") + "원";
}

function todayStr() {
  const d = new Date();
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d - tz).toISOString().slice(0, 10);
}

function showToast(msg, ms = 2200) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.add("hidden"), ms);
}

function setSyncMsg(msg) {
  document.getElementById("syncMsg").textContent = msg || "";
}

function setDriveStatus(mode) {
  // mode: 'off' | 'on' | 'busy'
  const dot = document.getElementById("driveStatusDot");
  const text = document.getElementById("driveStatusText");
  dot.className = "dot dot-" + mode;
  if (mode === "on") text.textContent = "드라이브 연결됨";
  else if (mode === "busy") text.textContent = "동기화 중...";
  else text.textContent = "드라이브 연결";
}

// ------------------- 로컬 저장 -------------------

function loadLocal() {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.transactions)) state = parsed;
    }
  } catch (e) {
    console.warn("로컬 데이터 로드 실패", e);
  }
}

function saveLocal() {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn("로컬 저장 실패", e);
  }
}

// ------------------- 렌더링 -------------------

function populateCategorySelect(sel, selected) {
  sel.innerHTML = "";
  CATEGORIES.forEach((c) => {
    const opt = document.createElement("option");
    opt.value = c.key;
    opt.textContent = c.key;
    if (c.key === selected) opt.selected = true;
    sel.appendChild(opt);
  });
}

function renderAll() {
  renderSummary();
  renderTxList();
}

function currentMonthKey() {
  return todayStr().slice(0, 7); // YYYY-MM
}

function renderSummary() {
  const mk = currentMonthKey();
  const monthTx = state.transactions.filter((t) => t.date && t.date.slice(0, 7) === mk);
  const total = monthTx.reduce((s, t) => s + Number(t.amount || 0), 0);
  document.getElementById("summaryMonthLabel").textContent = `${Number(mk.slice(5, 7))}월 지출`;
  document.getElementById("summaryTotal").textContent = formatWon(total);

  const byCat = {};
  monthTx.forEach((t) => {
    byCat[t.category] = (byCat[t.category] || 0) + Number(t.amount || 0);
  });
  const rows = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  const wrap = document.getElementById("categoryBars");
  wrap.innerHTML = "";
  const max = rows.length ? rows[0][1] : 0;
  rows.forEach(([cat, amt]) => {
    const row = document.createElement("div");
    row.className = "cat-bar-row";
    row.innerHTML = `
      <div class="cat-bar-label">${cat}</div>
      <div class="cat-bar-track"><div class="cat-bar-fill" style="width:${max ? (amt / max) * 100 : 0}%; background:${categoryColor(cat)}"></div></div>
      <div class="cat-bar-amount">${formatWon(amt)}</div>
    `;
    wrap.appendChild(row);
  });
}

function renderTxList() {
  const list = document.getElementById("txList");
  const empty = document.getElementById("emptyState");
  list.innerHTML = "";
  if (!state.transactions.length) {
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");

  const sorted = [...state.transactions].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return (b.createdAt || 0) - (a.createdAt || 0);
  });

  const groups = {};
  sorted.forEach((t) => {
    groups[t.date] = groups[t.date] || [];
    groups[t.date].push(t);
  });

  Object.keys(groups)
    .sort((a, b) => (a < b ? 1 : -1))
    .forEach((date) => {
      const groupEl = document.createElement("div");
      groupEl.className = "tx-day-group";
      const dayTotal = groups[date].reduce((s, t) => s + Number(t.amount || 0), 0);
      const label = document.createElement("div");
      label.className = "tx-day-label";
      label.textContent = `${date}  ·  ${formatWon(dayTotal)}`;
      groupEl.appendChild(label);

      groups[date].forEach((t) => {
        const row = document.createElement("div");
        row.className = "tx-row";
        row.innerHTML = `
          <span class="tx-cat-dot" style="background:${categoryColor(t.category)}"></span>
          <div class="tx-main">
            <div class="tx-item">${escapeHtml(t.item || "")}${t.store ? " · " + escapeHtml(t.store) : ""}</div>
            <div class="tx-sub">${escapeHtml(t.category)}</div>
          </div>
          <div class="tx-amount">${formatWon(t.amount)}</div>
        `;
        row.addEventListener("click", () => openEditSheet(t.id));
        groupEl.appendChild(row);
      });
      list.appendChild(groupEl);
    });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ------------------- 데이터 변경 (추가/수정/삭제) -------------------

function addTransactions(txs) {
  const now = Date.now();
  txs.forEach((t) => {
    state.transactions.push({
      id: uid(),
      date: t.date,
      store: t.store || "",
      item: t.item,
      category: t.category,
      amount: Number(t.amount) || 0,
      memo: t.memo || "",
      createdAt: now,
      updatedAt: now,
    });
  });
  onDataChanged();
}

function updateTransaction(id, patch) {
  const t = state.transactions.find((x) => x.id === id);
  if (!t) return;
  Object.assign(t, patch, { updatedAt: Date.now() });
  onDataChanged();
}

function deleteTransaction(id) {
  state.transactions = state.transactions.filter((x) => x.id !== id);
  onDataChanged();
}

function onDataChanged() {
  saveLocal();
  renderAll();
  scheduleDriveSave();
}

// ------------------- 영수증 OCR + 파싱 -------------------

const TOTAL_KEYWORDS = ["합계", "총액", "총 금액", "받을금액", "결제금액", "승인금액", "합 계", "결제 금액"];
const EXCLUDE_KEYWORDS = [
  "부가세", "과세", "면세", "카드", "현금", "승인", "포인트", "적립", "사업자", "대표자",
  "전화", "주소", "거스름", "받은돈", "잔액", "환불", "tel", "no.", "사업자등록번호",
  "감사합니다", "영수증", "매출전표", "가맹점", "단말기", "할부", "일시불", "유효기간",
];
const PRICE_RE = /(\d{1,3}(?:,\d{3})+|\d{4,})\s*원?\s*$/;
const DATE_RE = /(20\d{2})\s*[.\-\/년]\s*(\d{1,2})\s*[.\-\/월]\s*(\d{1,2})/;

function parseReceiptText(text) {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  let date = todayStr();
  const dm = text.match(DATE_RE);
  if (dm) {
    const y = dm[1];
    const m = String(dm[2]).padStart(2, "0");
    const d = String(dm[3]).padStart(2, "0");
    if (Number(m) >= 1 && Number(m) <= 12 && Number(d) >= 1 && Number(d) <= 31) {
      date = `${y}-${m}-${d}`;
    }
  }

  // 상호명 추정: 숫자 비중이 낮고 길이가 있는 상단 라인
  let store = "";
  for (let i = 0; i < Math.min(lines.length, 5); i++) {
    const l = lines[i];
    const digitRatio = (l.match(/\d/g) || []).length / l.length;
    if (l.length >= 2 && digitRatio < 0.4 && !TOTAL_KEYWORDS.some((k) => l.includes(k))) {
      store = l;
      break;
    }
  }

  const items = [];
  let totalGuess = null;

  for (const line of lines) {
    const lower = line.toLowerCase();
    const priceMatch = line.match(PRICE_RE);

    if (TOTAL_KEYWORDS.some((k) => line.includes(k))) {
      if (priceMatch) totalGuess = Number(priceMatch[1].replace(/,/g, ""));
      continue;
    }
    if (EXCLUDE_KEYWORDS.some((k) => lower.includes(k))) continue;
    if (!priceMatch) continue;

    const amount = Number(priceMatch[1].replace(/,/g, ""));
    if (amount < 100) continue; // 너무 작은 숫자(수량 등)는 제외

    let name = line.slice(0, priceMatch.index).trim();
    name = name.replace(/[*xX×]\s*\d+\s*$/, "").replace(/[\s.\-–_:]+$/, "").trim();
    if (!name) name = "품목";
    if (name.length > 24) name = name.slice(0, 24);

    items.push({
      name,
      amount,
      category: guessCategory(store + " " + name),
    });
  }

  // 항목을 하나도 못 찾았지만 합계는 찾은 경우 -> 합계를 단일 항목으로 제안
  if (!items.length && totalGuess) {
    items.push({ name: store || "지출", amount: totalGuess, category: guessCategory(store) });
  }

  return { date, store, items, totalGuess };
}

// ------------------- 카톡/문자 텍스트 붙여넣기 파싱 -------------------

const MSG_NOISE_RE = /Web\s*발신|승인|일시불|할부|누적|잔액|한도|국민카드|삼성카드|현대카드|신한카드|롯데카드|하나카드|우리카드|NH농협카드|nh농협카드|BC카드|bc카드|카카오뱅크|케이뱅크|토스뱅크|카카오페이|네이버페이|체크카드|신용카드|출금|입금|취소|잔여|가맹점|안내/gi;
const MSG_AMOUNT_RE = /\d{1,3}(?:,\d{3})+\s*원|\d+\s*원/g;
const MSG_FILLER_ACTION_RE = /(결제함|결제했어요|결제했|결제|썼어요|썼음|썼다|냈어요|냈어|냈다|샀어요|샀음|샀다|마셨어요|마심|마셨|먹었어요|먹음|먹었|지출함|지출|구매함|구매했|구매|이용함|이용했|이용|낸것같음|낸듯|함\.?|했어\.?|했다\.?)/g;

function toLocalISODate(d) {
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d - tz).toISOString().slice(0, 10);
}

function splitIntoMessageBlocks(text) {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  let blocks = normalized.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);

  if (blocks.length <= 1) {
    const reSplit = normalized.split(/(?=\[Web\s*발신\])/).map((b) => b.trim()).filter(Boolean);
    if (reSplit.length > 1) blocks = reSplit;
  }

  if (blocks.length <= 1) {
    const lines = normalized.split("\n").map((l) => l.trim()).filter(Boolean);
    const priceLines = lines.filter((l) => /\d{1,3}(,\d{3})*\s*원/.test(l));
    if (priceLines.length > 1 && lines.length <= priceLines.length * 2) {
      blocks = lines;
    }
  }
  return blocks;
}

function parseSingleMessageBlock(block) {
  const raw = block.trim();
  if (!raw) return null;

  const amtMatches = [...raw.matchAll(/(\d{1,3}(?:,\d{3})+|\d+)\s*원/g)];
  if (!amtMatches.length) return null;

  let amount = null;
  for (const m of amtMatches) {
    const context = raw.slice(Math.max(0, m.index - 8), m.index + m[0].length + 8);
    if (/누적|잔액|한도/.test(context)) continue;
    amount = Number(m[1].replace(/,/g, ""));
    break;
  }
  if (amount == null) amount = Number(amtMatches[0][1].replace(/,/g, ""));
  if (!amount || amount < 100) return null;

  let date = todayStr();
  const dm1 = raw.match(DATE_RE);
  const dm2 = raw.match(/(\d{1,2})[\/.](\d{1,2})\s+\d{1,2}:\d{2}/);
  const dm3 = raw.match(/(?:^|[^\d])(\d{1,2})[\/.](\d{1,2})(?!\d)/);
  if (dm1) {
    const y = dm1[1];
    const m = String(dm1[2]).padStart(2, "0");
    const d = String(dm1[3]).padStart(2, "0");
    if (Number(m) >= 1 && Number(m) <= 12 && Number(d) >= 1 && Number(d) <= 31) date = `${y}-${m}-${d}`;
  } else if (dm2 || dm3) {
    const mm = String((dm2 || dm3)[1]).padStart(2, "0");
    const dd = String((dm2 || dm3)[2]).padStart(2, "0");
    if (Number(mm) >= 1 && Number(mm) <= 12 && Number(dd) >= 1 && Number(dd) <= 31) {
      const y = new Date().getFullYear();
      date = `${y}-${mm}-${dd}`;
    }
  } else if (/어제/.test(raw)) {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    date = toLocalISODate(d);
  } else if (/그제|엊그제/.test(raw)) {
    const d = new Date();
    d.setDate(d.getDate() - 2);
    date = toLocalISODate(d);
  }

  let store = "";
  let item = "";

  // 1) "OO에서" 패턴 → 매장명 + 이후 텍스트에서 품목 추출 (캐주얼 채팅체)
  const eseoMatch = raw.match(/([가-힣A-Za-z0-9&.\s]{2,20}?)에서\s/);
  if (eseoMatch) {
    let cand = eseoMatch[1].trim();
    cand = cand.replace(/^(오늘|어제|그제|아까|방금|저번에|지난번에)\s*/, "").trim();
    if (cand && cand.length <= 20) {
      store = cand;
      const amtMatch = raw.match(MSG_AMOUNT_RE);
      const afterEseoIdx = eseoMatch.index + eseoMatch[0].length;
      const amtIdx = amtMatch ? raw.indexOf(amtMatch[0], afterEseoIdx - 20) : -1;
      if (amtIdx > afterEseoIdx) {
        const between = raw.slice(afterEseoIdx, amtIdx).replace(MSG_FILLER_ACTION_RE, "").trim();
        if (between && between.length <= 14) item = between;
      }
    }
  }

  // 2) 매장명을 못 찾았으면: 줄 단위로 검사, 노이즈/금액/날짜/시간/마스킹된 이름 줄을 제외하고
  //    남는 줄 중 "마지막" 후보를 매장명으로 사용 (카드 승인 문자는 보통 매장명이 뒤쪽에 옴)
  if (!store) {
    const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
    let lastCandidate = "";
    for (const line of lines) {
      if (/\d{1,3}(,\d{3})*\s*원/.test(line)) continue;
      if (/^\d{1,2}[\/.]\d{1,2}/.test(line)) continue;
      if (/^\d{1,2}:\d{2}/.test(line)) continue;
      if (/\*.{0,6}\(\d{2,}\)/.test(line)) continue; // 마스킹된 이름(홍*동(1234)) 제외
      MSG_NOISE_RE.lastIndex = 0;
      if (MSG_NOISE_RE.test(line)) continue;
      if (line.replace(/[^가-힣A-Za-z]/g, "").length < 2) continue;
      lastCandidate = line.replace(/\(\d+\)/, "").trim();
    }
    if (lastCandidate) store = lastCandidate;
  }

  const feeMatch = raw.match(/([가-힣]{2,8}(?:비|값|요금))\s*[:\-]?\s*\d[\d,]*\s*원/);

  // 3) 한 줄짜리 문자 등, 위 방법으로도 못 찾았으면: 노이즈/금액/날짜/필러 단어를 모두
  //    제거하고 남는 텍스트를 매장명(겸 품목)으로 사용
  //    (단, "OO비/값/요금"처럼 항목 설명일 뿐 매장명이 아닌 경우는 제외)
  if (!store && !feeMatch) {
    MSG_NOISE_RE.lastIndex = 0;
    let cleaned = raw
      .replace(/\[[^\]]*\]/g, "") // [Web발신], [삼성카드] 등 대괄호 전체 제거
      .replace(MSG_NOISE_RE, "")
      .replace(MSG_AMOUNT_RE, "")
      .replace(/\d{1,2}[\/.]\d{1,2}(\s+\d{1,2}:\d{2})?/g, "")
      .replace(/\(\d+\)/g, "")
      .replace(/[\n\r]/g, " ")
      .replace(MSG_FILLER_ACTION_RE, "")
      .replace(/\s{2,}/g, " ")
      .trim();
    cleaned = cleaned.replace(/[.,\-–_:]+$/, "").trim();
    if (cleaned) store = cleaned.slice(0, 20);
  }

  if (feeMatch && !item) item = feeMatch[1];
  if (!item) item = store || "지출";
  item = item.replace(/[.,\-–_:]+$/, "").trim() || "지출";

  return { date, store, item, amount };
}

// 카톡/문자 등 붙여넣은 텍스트에서 여러 건의 지출을 추출해 리뷰 카드 형식으로 변환
function parseMessageText(rawText) {
  const blocks = splitIntoMessageBlocks(rawText);
  const parsedTxs = blocks.map(parseSingleMessageBlock).filter((t) => t && t.amount);
  if (!parsedTxs.length) return null;

  const dates = [...new Set(parsedTxs.map((t) => t.date))];
  const stores = [...new Set(parsedTxs.map((t) => t.store).filter(Boolean))];
  const commonDate = dates.length === 1 ? dates[0] : todayStr();
  const commonStore = stores.length === 1 && parsedTxs.length === 1 ? stores[0] : "";

  const items = parsedTxs.map((t) => {
    let name = t.item || t.store || "지출";
    if (stores.length > 1 && t.store && !name.includes(t.store)) {
      name = t.store + " " + name;
    }
    if (dates.length > 1 && t.date !== commonDate) {
      name += ` (${t.date.slice(5).replace("-", "/")})`;
    }
    name = name.trim().slice(0, 28);
    return { name, amount: t.amount, category: guessCategory((t.store || "") + " " + (t.item || "")) };
  });

  return { date: commonDate, store: commonStore, items };
}

function handlePasteTextParse() {
  const raw = document.getElementById("pasteTextInput").value;
  if (!raw || !raw.trim()) {
    showToast("붙여넣은 텍스트가 없어요.");
    return;
  }
  const parsed = parseMessageText(raw);
  if (!parsed || !parsed.items.length) {
    showToast("금액을 찾지 못했어요. 직접 입력해 주세요.");
    openQuickAdd();
    return;
  }
  openReviewCard(parsed);
  document.getElementById("pasteTextInput").value = "";
}

// ------------------- OCR 실행 -------------------

async function runOcr(file) {
  const wrap = document.getElementById("ocrProgressWrap");
  const fill = document.getElementById("ocrProgressFill");
  const text = document.getElementById("ocrProgressText");
  wrap.classList.remove("hidden");
  fill.style.width = "0%";
  text.textContent = "이미지 불러오는 중...";

  const preview = document.getElementById("receiptPreview");
  preview.src = URL.createObjectURL(file);
  preview.classList.remove("hidden");

  try {
    const result = await Tesseract.recognize(file, "kor+eng", {
      logger: (m) => {
        if (m.status && typeof m.progress === "number") {
          fill.style.width = Math.round(m.progress * 100) + "%";
          const statusMap = {
            "loading tesseract core": "엔진 불러오는 중",
            "initializing tesseract": "엔진 준비 중",
            "loading language traineddata": "언어 데이터 불러오는 중",
            "initializing api": "준비 중",
            "recognizing text": "글자 인식 중",
          };
          text.textContent = (statusMap[m.status] || m.status) + " " + Math.round(m.progress * 100) + "%";
        }
      },
    });
    wrap.classList.add("hidden");
    return result.data.text || "";
  } catch (e) {
    wrap.classList.add("hidden");
    console.error(e);
    showToast("영수증 인식에 실패했어요. 다시 시도해 주세요.");
    return "";
  }
}

async function handleReceiptFile(file) {
  if (!file) return;
  const text = await runOcr(file);
  if (!text.trim()) {
    showToast("글자를 인식하지 못했어요. 직접 입력해 주세요.");
    openQuickAdd();
    return;
  }
  const parsed = parseReceiptText(text);
  openReviewCard(parsed);
}

// ------------------- 인식 결과 편집 카드 -------------------

function openReviewCard(parsed) {
  pendingReviewData = parsed;
  document.getElementById("reviewDate").value = parsed.date;
  document.getElementById("reviewStore").value = parsed.store;

  const rowsWrap = document.getElementById("reviewRows");
  rowsWrap.innerHTML = "";
  if (!parsed.items.length) {
    addReviewRow({ name: "", amount: "", category: "기타" });
  } else {
    parsed.items.forEach((it) => addReviewRow(it));
  }
  document.getElementById("reviewCard").classList.remove("hidden");
  document.getElementById("quickAddCard").classList.add("hidden");
  document.getElementById("reviewCard").scrollIntoView({ behavior: "smooth", block: "start" });
}

function addReviewRow(item) {
  const tpl = document.getElementById("reviewRowTpl");
  const node = tpl.content.firstElementChild.cloneNode(true);
  node.querySelector(".rr-name").value = item.name || "";
  node.querySelector(".rr-amount").value = item.amount || "";
  populateCategorySelect(node.querySelector(".rr-category"), item.category || "기타");
  node.querySelector(".rr-delete").addEventListener("click", () => node.remove());
  document.getElementById("reviewRows").appendChild(node);
}

function closeReviewCard() {
  document.getElementById("reviewCard").classList.add("hidden");
  document.getElementById("receiptPreview").classList.add("hidden");
  pendingReviewData = null;
}

function registerReview() {
  const date = document.getElementById("reviewDate").value || todayStr();
  const store = document.getElementById("reviewStore").value.trim();
  const rows = [...document.querySelectorAll("#reviewRows .review-row")];

  const txs = [];
  for (const row of rows) {
    const name = row.querySelector(".rr-name").value.trim();
    const amount = Number(row.querySelector(".rr-amount").value);
    const category = row.querySelector(".rr-category").value;
    if (!name || !amount) continue;
    txs.push({ date, store, item: name, amount, category });
  }
  if (!txs.length) {
    showToast("등록할 항목이 없어요. 품목명과 금액을 입력해 주세요.");
    return;
  }
  addTransactions(txs);
  showToast(`${txs.length}건 등록됨 · 자동 저장 중`);
  closeReviewCard();
  document.getElementById("cameraInput").value = "";
  document.getElementById("galleryInput").value = "";
}

// ------------------- 직접 입력 -------------------

function openQuickAdd() {
  document.getElementById("qaDate").value = todayStr();
  document.getElementById("qaStore").value = "";
  document.getElementById("qaItem").value = "";
  document.getElementById("qaAmount").value = "";
  populateCategorySelect(document.getElementById("qaCategory"), "기타");
  document.getElementById("quickAddCard").classList.remove("hidden");
  document.getElementById("reviewCard").classList.add("hidden");
  document.getElementById("quickAddCard").scrollIntoView({ behavior: "smooth", block: "start" });
}

function saveQuickAdd() {
  const date = document.getElementById("qaDate").value || todayStr();
  const store = document.getElementById("qaStore").value.trim();
  const item = document.getElementById("qaItem").value.trim();
  const amount = Number(document.getElementById("qaAmount").value);
  const category = document.getElementById("qaCategory").value;
  if (!item || !amount) {
    showToast("품목과 금액을 입력해 주세요.");
    return;
  }
  addTransactions([{ date, store, item, amount, category }]);
  showToast("저장됨 · 자동 저장 중");
  document.getElementById("quickAddCard").classList.add("hidden");
}

// ------------------- 내역 수정/삭제 시트 -------------------

function openEditSheet(id) {
  const t = state.transactions.find((x) => x.id === id);
  if (!t) return;
  editingTxId = id;

  const overlay = document.createElement("div");
  overlay.className = "edit-overlay";
  overlay.innerHTML = `
    <div class="edit-sheet">
      <h3>내역 수정</h3>
      <label>날짜 <input type="date" id="esDate" value="${t.date}"></label>
      <label>매장/메모 <input type="text" id="esStore" value="${escapeHtml(t.store || "")}"></label>
      <label>품목 <input type="text" id="esItem" value="${escapeHtml(t.item || "")}"></label>
      <label>금액 <input type="number" id="esAmount" value="${t.amount}"></label>
      <label>카테고리 <select id="esCategory"></select></label>
      <div class="edit-sheet-actions">
        <button id="esDelete" class="text-btn" style="color:#c94a4a">삭제</button>
        <div>
          <button id="esCancel" class="text-btn">취소</button>
          <button id="esSave" class="primary-btn">저장</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  populateCategorySelect(overlay.querySelector("#esCategory"), t.category);

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });
  overlay.querySelector("#esCancel").addEventListener("click", () => overlay.remove());
  overlay.querySelector("#esDelete").addEventListener("click", () => {
    if (confirm("이 내역을 삭제할까요?")) {
      deleteTransaction(id);
      overlay.remove();
      showToast("삭제됨 · 자동 저장 중");
    }
  });
  overlay.querySelector("#esSave").addEventListener("click", () => {
    const date = overlay.querySelector("#esDate").value;
    const store = overlay.querySelector("#esStore").value.trim();
    const item = overlay.querySelector("#esItem").value.trim();
    const amount = Number(overlay.querySelector("#esAmount").value);
    const category = overlay.querySelector("#esCategory").value;
    if (!item || !amount) {
      showToast("품목과 금액을 입력해 주세요.");
      return;
    }
    updateTransaction(id, { date, store, item, amount, category });
    overlay.remove();
    showToast("수정됨 · 자동 저장 중");
  });
}

// ============================================================
// Google Drive 동기화
// ============================================================

function driveConfigured() {
  return typeof GOOGLE_CLIENT_ID === "string" && GOOGLE_CLIENT_ID && !GOOGLE_CLIENT_ID.includes("여기에_발급받은");
}

function initGoogleAuth() {
  if (!driveConfigured()) {
    setDriveStatus("off");
    setSyncMsg("Google 연동이 아직 설정되지 않았어요 (config.js 확인)");
    return;
  }
  if (typeof google === "undefined" || !google.accounts) {
    // gsi 스크립트 로드 지연 대비 재시도
    setTimeout(initGoogleAuth, 300);
    return;
  }
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: DRIVE_SCOPE,
    callback: async (resp) => {
      if (resp && resp.access_token) {
        accessToken = resp.access_token;
        tokenExpiresAt = Date.now() + (Number(resp.expires_in) || 3500) * 1000;
        setDriveStatus("on");
        setSyncMsg("드라이브에서 최신 데이터 불러오는 중...");
        await pullFromDrive();
      } else {
        setDriveStatus("off");
      }
    },
  });

  // 자동(조용한) 로그인 시도: 이전에 동의한 적이 있다면 팝업 없이 재인증될 수 있음
  try {
    tokenClient.requestAccessToken({ prompt: "" });
  } catch (e) {
    // 사용자 제스처가 필요한 브라우저에서는 실패할 수 있음 -> 버튼으로 연결 유도
    setDriveStatus("off");
  }
}

function connectDriveClicked() {
  if (!driveConfigured()) {
    showToast("config.js에 Google 클라이언트 ID를 먼저 설정해 주세요.");
    return;
  }
  if (!tokenClient) {
    initGoogleAuth();
    return;
  }
  tokenClient.requestAccessToken({ prompt: "consent" });
}

function hasValidToken() {
  return accessToken && Date.now() < tokenExpiresAt - 30000;
}

async function driveFetch(url, options = {}) {
  if (!hasValidToken()) throw new Error("NO_TOKEN");
  const headers = Object.assign({}, options.headers, {
    Authorization: "Bearer " + accessToken,
  });
  return fetch(url, Object.assign({}, options, { headers }));
}

async function findDriveFile() {
  const q = encodeURIComponent(`name='${DRIVE_FILE_NAME}' and trashed=false`);
  const res = await driveFetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&fields=files(id,name,modifiedTime)&orderBy=modifiedTime desc`
  );
  if (!res.ok) throw new Error("LIST_FAILED");
  const data = await res.json();
  return data.files && data.files[0] ? data.files[0].id : null;
}

async function createDriveFile(content) {
  const metadata = { name: DRIVE_FILE_NAME, mimeType: "application/json" };
  const boundary = "budgetappboundary";
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify(metadata) +
    `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n` +
    content +
    `\r\n--${boundary}--`;

  const res = await driveFetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id",
    {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    }
  );
  if (!res.ok) throw new Error("CREATE_FAILED");
  const data = await res.json();
  return data.id;
}

async function updateDriveFile(fileId, content) {
  const res = await driveFetch(
    `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: content,
    }
  );
  if (!res.ok) throw new Error("UPDATE_FAILED");
}

async function downloadDriveFile(fileId) {
  const res = await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
  if (!res.ok) throw new Error("DOWNLOAD_FAILED");
  return res.text();
}

// 앱을 열었을 때: 드라이브의 최신 데이터를 가져와 로컬을 덮어씀
async function pullFromDrive() {
  if (!hasValidToken()) return;
  setDriveStatus("busy");
  try {
    driveFileId = await findDriveFile();
    if (driveFileId) {
      const text = await downloadDriveFile(driveFileId);
      const remote = JSON.parse(text);
      if (remote && Array.isArray(remote.transactions)) {
        state = remote; // 최신 정보로 덮어쓰기
        saveLocal();
        renderAll();
      }
      setSyncMsg("최신 데이터를 불러왔어요.");
    } else {
      // 드라이브에 아직 파일이 없으면 현재 로컬 데이터로 새로 생성
      driveFileId = await createDriveFile(JSON.stringify(state));
      setSyncMsg("드라이브에 새 저장 파일을 만들었어요.");
    }
    localStorage.setItem(LAST_SYNC_KEY, String(Date.now()));
    setDriveStatus("on");
  } catch (e) {
    console.warn("드라이브 불러오기 실패", e);
    setDriveStatus(hasValidToken() ? "on" : "off");
    setSyncMsg("드라이브 동기화에 실패했어요. 로컬 데이터로 계속 진행합니다.");
  }
}

// 변경이 생길 때마다 (디바운스) 드라이브에 자동 저장
function scheduleDriveSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    pushToDrive();
  }, 1200);
}

async function pushToDrive(useKeepalive = false) {
  if (!driveConfigured()) return;
  if (!hasValidToken()) return; // 로그인 안 된 상태면 로컬에만 저장됨
  if (isSaving && !useKeepalive) return;
  isSaving = true;
  setDriveStatus("busy");
  const content = JSON.stringify(state);
  try {
    if (!driveFileId) {
      driveFileId = await findDriveFile();
    }
    if (!driveFileId) {
      driveFileId = await createDriveFile(content);
    } else if (useKeepalive) {
      // 페이지 종료 시점: 응답을 기다리지 않고 최대한 빠르게 전송
      fetch(`https://www.googleapis.com/upload/drive/v3/files/${driveFileId}?uploadType=media`, {
        method: "PATCH",
        headers: {
          Authorization: "Bearer " + accessToken,
          "Content-Type": "application/json",
        },
        body: content,
        keepalive: true,
      });
    } else {
      await updateDriveFile(driveFileId, content);
    }
    setDriveStatus("on");
    setSyncMsg("자동 저장됨 · " + new Date().toLocaleTimeString("ko-KR"));
    localStorage.setItem(LAST_SYNC_KEY, String(Date.now()));
  } catch (e) {
    console.warn("드라이브 저장 실패", e);
    setSyncMsg("드라이브 저장 실패 (로컬에는 저장됨)");
  } finally {
    isSaving = false;
  }
}

// 앱을 닫거나 화면을 벗어날 때 마지막 저장 시도
function setupUnloadSave() {
  const flush = () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      pushToDrive(true);
    }
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
  window.addEventListener("pagehide", flush);
  window.addEventListener("beforeunload", flush);
}

// ------------------- 초기화 -------------------

function init() {
  loadLocal();
  renderAll();
  setupUnloadSave();

  document.getElementById("cameraInput").addEventListener("change", (e) => handleReceiptFile(e.target.files[0]));
  document.getElementById("galleryInput").addEventListener("change", (e) => handleReceiptFile(e.target.files[0]));
  document.getElementById("pasteTextBtn").addEventListener("click", handlePasteTextParse);
  document.getElementById("addRowBtn").addEventListener("click", () => addReviewRow({ name: "", amount: "", category: "기타" }));
  document.getElementById("cancelReviewBtn").addEventListener("click", closeReviewCard);
  document.getElementById("registerBtn").addEventListener("click", registerReview);

  document.getElementById("quickAddBtn").addEventListener("click", openQuickAdd);
  document.getElementById("qaCancelBtn").addEventListener("click", () => document.getElementById("quickAddCard").classList.add("hidden"));
  document.getElementById("qaSaveBtn").addEventListener("click", saveQuickAdd);

  document.getElementById("driveBtn").addEventListener("click", connectDriveClicked);

  setDriveStatus("off");
  initGoogleAuth();

  if ("serviceWorker" in navigator) {
    // 오프라인 셸 캐싱은 사용하지 않음 (드라이브 동기화 로직과의 캐시 충돌 방지)
  }
}

document.addEventListener("DOMContentLoaded", init);
