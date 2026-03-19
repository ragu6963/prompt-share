// ───────────────────────────────────────────
// 상태
// ───────────────────────────────────────────
const TAB_CONFIG = [
  { id: 'clean-html', label: '원본 HTML',           desc: 'ICON 데이터를 포함한 원본 그대로의 HTML이다. AI가 분석을 어려워하는 이유를 확인할 수 있다.' },
  { id: 'markdown',   label: '마크다운 구조',  desc: '폴더를 헤더(##)로, 링크를 마크다운 형식으로 출력한다. URL을 포함하므로 중복 탐지에 유리하다.' },
];

let currentTab = 'clean-html';
let outputs = {};
let stats = {};
let parsedBookmarks = null; // 파싱된 트리 구조
let currentMode = 'refine'; // 'refine' | 'fresh'

// 분할 상태
const CHUNK_CHAR_LIMIT = 30000;
let chunks = [];
let currentChunk = 0;

// ───────────────────────────────────────────
// 이벤트 바인딩
// ───────────────────────────────────────────
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');

dropZone.addEventListener('click', () => fileInput.click());
document.getElementById('btn-browse').addEventListener('click', e => {
  e.stopPropagation();
  fileInput.click();
});

dropZone.addEventListener('dragover', e => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});

dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));

dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) processFile(file);
});

fileInput.addEventListener('change', e => {
  const file = e.target.files[0];
  if (file) processFile(file);
  fileInput.value = '';
});

// 모드 선택
function selectMode(mode) {
  currentMode = mode;
  document.querySelectorAll('.mode-card').forEach(card => {
    card.classList.toggle('active', card.dataset.mode === mode);
  });
  if (outputs['markdown']) renderPrompt();
}

// 사용자 요구사항 입력 시 프롬프트 실시간 갱신
document.getElementById('user-requirements').addEventListener('input', () => {
  if (outputs['markdown']) renderPrompt();
});

// ───────────────────────────────────────────
// 탭 렌더링
// ───────────────────────────────────────────
function renderTabs() {
  const group = document.getElementById('tab-group');
  group.innerHTML = TAB_CONFIG.map(t =>
    `<button class="tab-btn${t.id === currentTab ? ' active' : ''}" data-tab="${t.id}">${t.label}</button>`
  ).join('');
  group.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
  updateTabDesc();
}

function updateTabDesc() {
  const cfg = TAB_CONFIG.find(t => t.id === currentTab);
  document.getElementById('tab-desc').textContent = cfg ? cfg.desc : '';
}

function switchTab(tabId) {
  currentTab = tabId;
  renderTabs();
  updateChunks();
  showCurrentOutput();
}

// ───────────────────────────────────────────
// 파일 처리 (메인)
// ───────────────────────────────────────────
function processFile(file) {
  hideError();

  const reader = new FileReader();
  reader.onerror = () => showError('파일을 읽을 수 없다. 다시 시도한다.');
  reader.onload = e => {
    try {
      const originalText = e.target.result;
      const originalSize = new Blob([originalText]).size;

      // 파싱
      parsedBookmarks = parseBookmarkHtml(originalText);

      if (!parsedBookmarks || parsedBookmarks.children.length === 0) {
        showError('북마크 데이터를 찾을 수 없다. 브라우저에서 내보낸 북마크 HTML 파일인지 확인한다.');
        return;
      }

      // 통계
      const linkCount = countLinks(parsedBookmarks);
      const folderCount = countFolders(parsedBookmarks);

      // 각 형식 생성
      outputs['markdown'] = generateMarkdown(parsedBookmarks);
      outputs['clean-html'] = originalText;

      const cleanSize = new Blob([outputs['markdown']]).size;

      stats = {
        originalKB: Math.round(originalSize / 1024),
        cleanKB: Math.round(cleanSize / 1024),
        reduction: Math.round((1 - cleanSize / originalSize) * 100),
        links: linkCount,
        folders: folderCount,
        originalChars: originalText.length,
        markdownChars: outputs['markdown'].length,
      };

      renderStats();
      renderTabs();
      updateChunks();
      showCurrentOutput();

      document.getElementById('stats-area').style.display = 'block';
      document.getElementById('chatbot-area').style.display = 'block';
      document.getElementById('convert-area').style.display = 'block';
      renderPrompt();

      document.getElementById('stats-area').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      showError('파일 처리 중 오류가 발생했다: ' + err.message);
    }
  };
  reader.readAsText(file, 'UTF-8');
}

// ───────────────────────────────────────────
// 북마크 HTML → 트리 구조 파싱
// Netscape 북마크 형식을 정규식 기반으로 직접 파싱한다.
// DOMParser 사용 시 브라우저가 DT/DL 관계를 재해석하여
// 트리 구조가 깨지는 문제를 피한다.
// ───────────────────────────────────────────
function parseBookmarkHtml(html) {
  const root = { type: 'folder', title: '북마크', children: [] };
  const stack = [root];

  // 한 줄씩 처리
  const lines = html.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();

    // 폴더 시작: <H3 ...>Folder Name</H3>
    const folderMatch = trimmed.match(/<H3[^>]*>(.*?)<\/H3>/i);
    if (folderMatch) {
      const folder = {
        type: 'folder',
        title: decodeHtmlEntities(folderMatch[1]),
        children: [],
      };
      stack[stack.length - 1].children.push(folder);
      stack.push(folder);
      continue;
    }

    // 링크: <A HREF="..." ADD_DATE="..." ...>Title</A>
    const linkMatch = trimmed.match(/<A\s+([^>]*)>(.*?)<\/A>/i);
    if (linkMatch) {
      const attrs = linkMatch[1];
      const title = decodeHtmlEntities(linkMatch[2]) || '';
      const hrefMatch = attrs.match(/HREF\s*=\s*"([^"]*)"/i);
      const addDateMatch = attrs.match(/ADD_DATE\s*=\s*"([^"]*)"/i);
      const href = hrefMatch ? hrefMatch[1] : '';

      stack[stack.length - 1].children.push({
        type: 'link',
        title: title,
        url: href,
        addDate: addDateMatch ? addDateMatch[1] : '',
      });
      continue;
    }

    // DL 닫힘: </DL> — 폴더 종료
    if (/<\/DL>/i.test(trimmed)) {
      if (stack.length > 1) stack.pop();
      continue;
    }
  }

  return root;
}

function decodeHtmlEntities(str) {
  const textarea = document.createElement('textarea');
  textarea.innerHTML = str;
  return textarea.value;
}

function countLinks(node) {
  if (node.type === 'link') return 1;
  return (node.children || []).reduce((sum, c) => sum + countLinks(c), 0);
}

function countFolders(node) {
  if (node.type === 'link') return 0;
  return (node.children || []).reduce((sum, c) => sum + (c.type === 'folder' ? 1 : 0) + countFolders(c), 0);
}

// ───────────────────────────────────────────
// 출력 형식 1: 구조만 (제목 + 폴더, URL 제외)
// ───────────────────────────────────────────
function generateStructure(root) {
  const lines = [];

  function walk(node, indent) {
    if (node.type === 'folder') {
      if (node !== root) {
        lines.push(' '.repeat(indent) + '[' + node.title + ']');
      }
      for (const child of node.children) {
        walk(child, node === root ? 0 : indent + 2);
      }
    } else {
      lines.push(' '.repeat(indent) + '- ' + node.title);
    }
  }

  walk(root, 0);
  return lines.join('\n');
}

// ───────────────────────────────────────────
// 출력 형식 2: 마크다운 (URL 포함)
// ───────────────────────────────────────────
function generateMarkdown(root) {
  const lines = ['# 북마크'];

  function walk(node, level) {
    if (node.type === 'folder' && node !== root) {
      const depth = Math.min(level, 5);
      lines.push('');
      lines.push('#'.repeat(depth + 1) + ' ' + node.title);
    }

    for (const child of (node.children || [])) {
      if (child.type === 'folder') {
        walk(child, node === root ? 1 : level + 1);
      } else {
        const safeTitle = escapeMarkdown(child.title || child.url);
        const safeUrl = child.url.replace(/\)/g, '%29');
        lines.push('- [' + safeTitle + '](' + safeUrl + ')');
      }
    }
  }

  walk(root, 1);
  return lines.join('\n');
}

function escapeMarkdown(text) {
  return text.replace(/\[/g, '\\[').replace(/\]/g, '\\]');
}

// ───────────────────────────────────────────
// 출력 형식: 플랫 마크다운 (폴더 구조 제거, 링크만)
// ───────────────────────────────────────────
function generateFlatMarkdown(root) {
  const lines = [];

  function walk(node) {
    if (node.type === 'link') {
      const safeTitle = escapeMarkdown(node.title || node.url);
      const safeUrl = node.url.replace(/\)/g, '%29');
      lines.push('- [' + safeTitle + '](' + safeUrl + ')');
    }
    for (const child of (node.children || [])) {
      walk(child);
    }
  }

  walk(root);
  return lines.join('\n');
}

// ───────────────────────────────────────────
// 출력 형식 3: URL 목록
// ───────────────────────────────────────────
function generateUrlList(root) {
  const lines = [];

  function walk(node, pathParts) {
    if (node.type === 'folder') {
      const newPath = node === root ? [] : [...pathParts, node.title];
      for (const child of node.children) {
        walk(child, newPath);
      }
    } else {
      const folder = pathParts.join(' > ') || '(최상위)';
      lines.push(folder + ' | ' + node.title + ' | ' + node.url);
    }
  }

  walk(root, []);
  return lines.join('\n');
}

// ───────────────────────────────────────────
// 출력 형식 4: 정리된 HTML (ADD_DATE 보존)
// ───────────────────────────────────────────
function generateCleanHtml(root) {
  const lines = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
  ];

  function walk(node, indent) {
    for (const child of (node.children || [])) {
      const pad = ' '.repeat(indent);
      if (child.type === 'folder') {
        lines.push(pad + '<DT><H3>' + escapeHtml(child.title) + '</H3>');
        lines.push(pad + '<DL><p>');
        walk(child, indent + 4);
        lines.push(pad + '</DL><p>');
      } else {
        const addDate = child.addDate ? ' ADD_DATE="' + child.addDate + '"' : '';
        const href = escapeHtmlAttr(child.url);
        lines.push(pad + '<DT><A HREF="' + href + '"' + addDate + '>' + escapeHtml(child.title) + '</A>');
      }
    }
  }

  lines.push('<DL><p>');
  walk(root, 4);
  lines.push('</DL><p>');

  return lines.join('\n');
}

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeHtmlAttr(text) {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ───────────────────────────────────────────
// 분할 처리 (대용량 대응)
// ───────────────────────────────────────────
function updateChunks() {
  const text = outputs[currentTab] || '';
  const chunkInfo = document.getElementById('chunk-info');

  if (text.length <= CHUNK_CHAR_LIMIT) {
    chunks = [text];
    currentChunk = 0;
    chunkInfo.style.display = 'none';
    return;
  }

  // 줄 단위로 분할
  const lines = text.split('\n');
  chunks = [];
  let current = '';

  for (const line of lines) {
    if (current.length + line.length + 1 > CHUNK_CHAR_LIMIT && current.length > 0) {
      chunks.push(current);
      current = '';
    }
    current += (current ? '\n' : '') + line;
  }
  if (current) chunks.push(current);

  currentChunk = 0;

  if (chunks.length > 1) {
    chunkInfo.style.display = 'block';
    chunkInfo.innerHTML =
      '텍스트가 길어서 <strong>' + chunks.length + '개</strong>로 분할함.' +
      '<div class="chunk-nav" id="chunk-nav"></div>';
    renderChunkNav();
  } else {
    chunkInfo.style.display = 'none';
  }
}

function renderChunkNav() {
  const nav = document.getElementById('chunk-nav');
  if (!nav) return;
  nav.innerHTML = chunks.map((_, i) =>
    '<button class="' + (i === currentChunk ? 'active' : '') + '" onclick="goToChunk(' + i + ')">' +
    (i + 1) + '/' + chunks.length +
    '</button>'
  ).join('');
}

function goToChunk(index) {
  currentChunk = index;
  showCurrentOutput();
  renderChunkNav();
}

function showCurrentOutput() {
  const textarea = document.getElementById('output');
  textarea.value = chunks.length > 0 ? chunks[currentChunk] : (outputs[currentTab] || '');
}

// ───────────────────────────────────────────
// 통계 렌더링
// ───────────────────────────────────────────
function renderStats() {
  const grid = document.getElementById('stats-grid');
  grid.innerHTML =
    '<div class="stat-row">' +
      '<div class="stat-box"><div class="num">' + stats.links.toLocaleString() + '</div><div class="label">북마크 수</div></div>' +
      '<div class="stat-box"><div class="num">' + stats.folders.toLocaleString() + '</div><div class="label">폴더 수</div></div>' +
    '</div>' +
    '<div class="stat-row">' +
      '<div class="stat-box stat-html"><div class="num">' + stats.originalKB.toLocaleString() + ' KB</div><div class="label">원본 HTML 크기</div></div>' +
      '<div class="stat-box stat-md"><div class="num">' + stats.cleanKB.toLocaleString() + ' KB</div><div class="label">마크다운 크기</div></div>' +
      '<div class="stat-box"><div class="num">' + stats.reduction + '%</div><div class="label">크기 감소율</div></div>' +
    '</div>' +
    '<div class="stat-row">' +
      '<div class="stat-box stat-html"><div class="num">' + stats.originalChars.toLocaleString() + '</div><div class="label">원본 HTML 글자 수</div></div>' +
      '<div class="stat-box stat-md"><div class="num">' + stats.markdownChars.toLocaleString() + '</div><div class="label">마크다운 글자 수</div></div>' +
    '</div>';
}

// ───────────────────────────────────────────
// 복사 (file:// 프로토콜 폴백 포함)
// ───────────────────────────────────────────
function copyToClipboard(text, feedbackId) {
  const feedback = document.getElementById(feedbackId);

  function onSuccess() {
    feedback.classList.add('show');
    setTimeout(() => feedback.classList.remove('show'), 2000);
  }

  function onFail() {
    // 폴백: textarea 선택 후 execCommand
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      onSuccess();
    } catch (err) {
      // 최후 폴백: 사용자에게 직접 선택 안내
      const output = document.getElementById('output');
      output.value = text;
      output.select();
      output.focus();
      alert('자동 복사가 제한된 환경이다. 텍스트가 선택되었으니 Ctrl+C를 눌러 직접 복사한다.');
    }
    document.body.removeChild(ta);
  }

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(onSuccess).catch(onFail);
  } else {
    onFail();
  }
}


// ───────────────────────────────────────────
// 에러 표시
// ───────────────────────────────────────────
function showError(msg) {
  const el = document.getElementById('error-msg');
  el.textContent = msg;
  el.style.display = 'block';
  document.getElementById('stats-area').style.display = 'none';
  document.getElementById('chatbot-area').style.display = 'none';
  document.getElementById('convert-area').style.display = 'none';
  document.getElementById('import-area').style.display = 'none';
}

function hideError() {
  document.getElementById('error-msg').style.display = 'none';
}

// ───────────────────────────────────────────
// 프롬프트 생성 (모드별 분기)
// ───────────────────────────────────────────
function renderPrompt() {
  const count = stats.links || 0;
  const userReq = (document.getElementById('user-requirements') || {}).value || '';

  // 사용자 요구사항을 조건 항목으로 변환
  let userConditions = '';
  if (userReq.trim()) {
    const lines = userReq.trim().split('\n');
    userConditions = '\n' + lines.map(line => {
      const trimmed = line.trim();
      if (!trimmed) return '';
      return trimmed.startsWith('-') ? trimmed : '- ' + trimmed;
    }).filter(Boolean).join('\n') + '\n';
  }

  const userConditionBlock = userConditions
    ? '# 최우선 조건' + userConditions + '\n'
    : '';

  const isFresh = currentMode === 'fresh';
  const prompt = isFresh
    ? buildFreshPrompt(count, userConditionBlock)
    : buildRefinePrompt(count, userConditionBlock);

  document.getElementById('prompt-box').textContent = prompt;
}

function buildRefinePrompt(count, userConditionBlock) {
  const dataText = outputs['markdown'] || '';

  return '아래는 웹 브라우저 북마크 목록이다 (총 ' + count + '개).\n' +
    '\n' +
    '# 역할\n' +
    '기존 북마크 구조를 진단하고 개선안을 제시하는 정보 구조 리뷰어\n' +
    '\n' +
    '# 작업\n' +
    '아래 북마크의 기존 폴더 구조를 분석하고, 문제가 있는 부분만 수정하여 개선된 구조를 출력한다.\n' +
    '\n' +
    '# 개선 기준 (아래 항목에 해당하는 경우에만 수정한다)\n' +
    '- 이름이 다르지만 같은 주제를 담은 폴더가 있으면 하나로 병합한다.\n' +
    '- 한 폴더에 15개 이상의 북마크가 있으면 하위 폴더로 분산한다.\n' +
    '- 1~2개만 들어 있는 폴더는 상위 폴더에 통합하거나 유사 폴더와 병합한다.\n' +
    '- 폴더 이름이 모호하거나 너무 긴 경우 짧고 직관적인 한국어로 교체한다.\n' +
    '- 폴더 위치가 주제와 맞지 않는 북마크는 적절한 폴더로 이동한다.\n' +
    '- 위 항목에 해당하지 않는 기존 구조는 그대로 유지한다.\n' +
    '\n' +
    '# 조건 및 제약\n' +
    '- 폴더 깊이는 최대 3단계로 제한한다.\n' +
    '- 중복 URL이 있으면 하나만 남기고, 나머지는 "정리 후보" 폴더로 이동한다.\n' +
    '- 제목이 비어 있거나 내용을 알 수 없는 항목은 "정리 후보" 폴더로 분류한다.\n' +
    '- **누락 금지**: 입력된 ' + count + '개의 북마크를 전부 출력에 포함한다. 하나도 빠뜨리지 않는다.\n' +
    '- 작업 완료 후 출력한 북마크의 총 개수를 마지막에 명시한다 (예: "총 ' + count + '개 북마크 포함").\n' +
    '- 출력이 길어질 경우 중간에 끊지 말고, 필요하면 여러 메시지에 걸쳐 이어서 출력한다.\n' +
    '\n' +
    userConditionBlock +
    '# 출력 형식 (반드시 아래 마크다운 형식을 지킨다)\n' +
    '- 폴더는 ## 또는 ### 헤더로 표시한다.\n' +
    '- 각 북마크는 `- [제목](URL)` 형식으로 작성한다.\n' +
    '- 개선된 구조는 마크다운 코드 블럭 내부에 작성한다.\n' +
    '- 코드 블럭 아래에 "주요 변경 사항" 섹션을 추가하여, 수정한 내용을 항목별로 요약한다.\n' +
    '\n' +
    '# 출력 예시\n' +
    '```markdown\n' +
    '# 개선된 북마크\n' +
    '## 개발\n' +
    '### 프론트엔드\n' +
    '- [React](https://react.dev)\n' +
    '- [MDN](https://developer.mozilla.org)\n' +
    '### 백엔드\n' +
    '- [Spring](https://spring.io)\n' +
    '## 정리 후보\n' +
    '- [제목 없음](https://example.com/unknown)\n' +
    '```\n' +
    '\n' +
    '**주요 변경 사항**\n' +
    '- "JS 참고자료" 폴더와 "프론트엔드" 폴더를 "프론트엔드"로 병합\n' +
    '- "기타" 폴더의 항목 3개를 주제에 맞는 폴더로 재배치\n' +
    '- 중복 URL 2개를 "정리 후보"로 이동\n' +
    '\n' +
    '# 북마크 구조\n' +
    '```markdown\n' +
    dataText +
    '\n' +
    '```';
}

function buildFreshPrompt(count, userConditionBlock) {
  const dataText = generateFlatMarkdown(parsedBookmarks);

  return '아래는 웹 브라우저 북마크 목록이다 (총 ' + count + '개).\n' +
    '기존 폴더 구조는 의도적으로 제거한 상태이다.\n' +
    '\n' +
    '# 역할\n' +
    '북마크 컬렉션을 처음부터 설계하는 정보 구조 설계자\n' +
    '\n' +
    '# 작업\n' +
    '아래 북마크를 분석하여, 기존 분류에 구애받지 않고 처음부터 최적의 폴더 구조를 설계한다.\n' +
    '\n' +
    '# 분류 원칙\n' +
    '- 주제(topic) 기반으로 분류한다. 같은 분야의 북마크는 하나의 폴더에 모은다.\n' +
    '- 각 폴더는 상호 배타적이어야 한다. 하나의 북마크가 여러 폴더에 해당하면 가장 핵심적인 주제의 폴더에 배치한다.\n' +
    '- 북마크의 제목과 URL 도메인을 모두 분류 단서로 활용한다 (예: github.com → 개발, figma.com → 디자인).\n' +
    '\n' +
    '# 조건 및 제약\n' +
    '- 폴더 이름은 짧고 직관적인 한국어로 작성한다.\n' +
    '- 폴더 깊이는 최대 3단계로 제한한다.\n' +
    '- 한 폴더에 15개 이상이면 하위 폴더로 분산한다.\n' +
    '- 중복 URL이 있으면 하나만 남기고, 나머지는 "정리 후보" 폴더로 이동한다.\n' +
    '- 제목이 비어 있거나 내용을 알 수 없는 항목은 "정리 후보" 폴더로 분류한다.\n' +
    '- **누락 금지**: 입력된 ' + count + '개의 북마크를 전부 출력에 포함한다. 하나도 빠뜨리지 않는다.\n' +
    '- 작업 완료 후 출력한 북마크의 총 개수를 마지막에 명시한다 (예: "총 ' + count + '개 북마크 포함").\n' +
    '- 출력이 길어질 경우 중간에 끊지 말고, 필요하면 여러 메시지에 걸쳐 이어서 출력한다.\n' +
    '\n' +
    userConditionBlock +
    '# 출력 형식 (반드시 아래 마크다운 형식을 지킨다)\n' +
    '- 폴더는 ## 또는 ### 헤더로 표시한다.\n' +
    '- 각 북마크는 `- [제목](URL)` 형식으로 작성한다.\n' +
    '- 개선된 구조는 마크다운 코드 블럭 내부에 작성한다.\n' +
    '- 코드 블럭 아래에 "분류 근거" 섹션을 추가하여, 최상위 폴더별로 어떤 기준으로 묶었는지 한 줄씩 설명한다.\n' +
    '\n' +
    '# 출력 예시\n' +
    '```markdown\n' +
    '# 개선된 북마크\n' +
    '## 개발\n' +
    '### 프론트엔드\n' +
    '- [React](https://react.dev)\n' +
    '- [MDN](https://developer.mozilla.org)\n' +
    '### 백엔드\n' +
    '- [Spring](https://spring.io)\n' +
    '## 정리 후보\n' +
    '- [제목 없음](https://example.com/unknown)\n' +
    '```\n' +
    '\n' +
    '**분류 근거**\n' +
    '- "개발": 프로그래밍 언어, 프레임워크, 개발 도구 관련 사이트를 통합\n' +
    '- "정리 후보": 제목이 없거나 URL만으로 용도를 판단할 수 없는 항목\n' +
    '\n' +
    '# 북마크 목록\n' +
    '```markdown\n' +
    dataText +
    '\n' +
    '```';
}

function copyPrompt() {
  const text = document.getElementById('prompt-box').textContent;
  copyToClipboard(text, 'prompt-copy-feedback');
}

// ───────────────────────────────────────────
// ④ AI 마크다운 결과 → 북마크 HTML 역변환
// ───────────────────────────────────────────
let convertedHtml = '';

function convertAiResult() {
  const input = document.getElementById('ai-input').value.trim();
  const errorEl = document.getElementById('convert-error');
  errorEl.style.display = 'none';

  // 이전 결과 초기화
  document.getElementById('convert-result').style.display = 'none';
  document.getElementById('missing-area').style.display = 'none';

  if (!input) {
    errorEl.textContent = 'AI 결과 텍스트를 붙여넣은 뒤 다시 시도한다.';
    errorEl.style.display = 'block';
    return;
  }

  try {
    const tree = parseMarkdownToTree(input);
    const linkCount = countLinks(tree);
    const folderCount = countFolders(tree);

    if (linkCount === 0) {
      errorEl.textContent = '북마크 링크를 찾을 수 없다. AI 결과에 "- [제목](URL)" 형식의 링크가 포함되어 있는지 확인한다.';
      errorEl.style.display = 'block';
      return;
    }

    convertedHtml = generateCleanHtml(tree);

    // 원본 대비 통계
    const originalCount = parsedBookmarks ? countLinks(parsedBookmarks) : 0;
    const compareHtml = originalCount > 0
      ? '<div class="convert-stat">원본 <strong>' + originalCount + '</strong>개</div>' +
        '<div class="convert-stat">변환 결과 <strong>' + linkCount + '</strong>개' +
        (linkCount < originalCount ? ' <span style="color:#c62828;font-size:0.8rem">(-' + (originalCount - linkCount) + ')</span>' : '') +
        (linkCount >= originalCount ? ' <span style="color:#2d8f47;font-size:0.8rem">OK</span>' : '') +
        '</div>'
      : '<div class="convert-stat">북마크 <strong>' + linkCount + '</strong>개</div>';

    document.getElementById('convert-stats').innerHTML =
      compareHtml +
      '<div class="convert-stat">폴더 <strong>' + folderCount + '</strong>개</div>' +
      '<div class="convert-stat">파일 크기 <strong>' + Math.round(new Blob([convertedHtml]).size / 1024) + '</strong> KB</div>';

    document.getElementById('convert-output').value = convertedHtml;
    document.getElementById('convert-result').style.display = 'block';
    document.getElementById('import-area').style.display = 'block';

    // 누락 검증
    renderMissingCheck(tree);

    // 누락 검증 영역이 표시된 경우 해당 영역으로 스크롤, 아니면 변환 결과로 스크롤
    const missingEl = document.getElementById('missing-area');
    if (missingEl && missingEl.style.display === 'block') {
      missingEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      document.getElementById('convert-result').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  } catch (err) {
    errorEl.textContent = '변환 중 오류가 발생했다: ' + err.message;
    errorEl.style.display = 'block';
  }
}

function parseMarkdownToTree(md) {
  const root = { type: 'folder', title: '북마크', children: [] };
  const stack = [{ node: root, level: 0 }];

  const lines = md.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // 마크다운 헤더: ## 폴더명, ### 하위폴더명
    const headerMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headerMatch) {
      const level = headerMatch[1].length;
      // H1(#)은 문서 제목이므로 폴더로 취급하지 않는다
      if (level === 1) continue;
      // AI가 "## ## 폴더명"처럼 중복 #을 출력하는 경우 제거
      const title = headerMatch[2].replace(/^#+\s*/, '').trim();

      // 헤더 레벨에 맞게 스택 조정
      while (stack.length > 1 && stack[stack.length - 1].level >= level) {
        stack.pop();
      }

      const folder = { type: 'folder', title: title, children: [] };
      stack[stack.length - 1].node.children.push(folder);
      stack.push({ node: folder, level: level });
      continue;
    }

    // 마크다운 링크: 다양한 AI 출력 변형을 처리
    // - [제목](URL), * [제목](URL), 1. [제목](URL), - **[제목]**(URL) 등
    const linkMatch = trimmed.match(/^(?:[-*]|\d+[.)]\s*)\s+(?:\*{1,2})?\[(.*?)\](?:\*{1,2})?\(([^)]+)\)/);
    if (linkMatch) {
      stack[stack.length - 1].node.children.push({
        type: 'link',
        title: linkMatch[1].replace(/\\([\[\]])/g, '$1'),
        url: linkMatch[2],
        addDate: '',
      });
      continue;
    }

    // 링크가 리스트 항목이 아닌 경우에도 처리: [제목](URL)
    const inlineLinkMatch = trimmed.match(/^\[(.*?)\]\(([^)]+)\)/);
    if (inlineLinkMatch) {
      stack[stack.length - 1].node.children.push({
        type: 'link',
        title: inlineLinkMatch[1].replace(/\\([\[\]])/g, '$1'),
        url: inlineLinkMatch[2],
        addDate: '',
      });
      continue;
    }
  }

  return root;
}

// ───────────────────────────────────────────
// 누락 검증: 원본 URL과 AI 결과 URL 대조
// ───────────────────────────────────────────
let missingBookmarks = [];

function collectUrls(node) {
  const urls = [];
  if (node.type === 'link' && node.url) {
    urls.push(node.url);
  }
  for (const child of (node.children || [])) {
    urls.push(...collectUrls(child));
  }
  return urls;
}

function collectLinksWithPath(node, path) {
  const results = [];
  if (node.type === 'link') {
    results.push({ title: node.title, url: node.url, folder: path || '(최상위)' });
  }
  for (const child of (node.children || [])) {
    const childPath = child.type === 'folder'
      ? (path ? path + ' > ' + child.title : child.title)
      : path;
    results.push(...collectLinksWithPath(child, childPath));
  }
  return results;
}

function normalizeUrl(url) {
  if (!url) return '';
  try {
    let raw = url.trim().replace(/%29/gi, ')');
    // 프로토콜이 없으면 임시로 붙여 URL 객체로 파싱
    if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
    const parsed = new URL(raw);
    // hostname + pathname 기준 비교 (쿼리·해시·www·끝슬래시 무시)
    const host = parsed.hostname.replace(/^www\./, '');
    const path = parsed.pathname.replace(/\/+$/, '');
    return host + path;
  } catch (e) {
    // URL 파싱 실패 시 기존 단순 비교로 폴백
    let u = String(url).trim().toLowerCase();
    u = u.replace(/%29/gi, ')');
    u = u.replace(/\/+$/, '');
    u = u.replace(/^https?:\/\//, '');
    u = u.replace(/^www\./, '');
    return u;
  }
}

function renderMissingCheck(aiTree) {
  const missingArea = document.getElementById('missing-area');
  const headerEl = document.getElementById('missing-header');
  const summaryEl = document.getElementById('missing-summary');
  const listEl = document.getElementById('missing-list');
  const btnRow = document.getElementById('missing-btn-row');

  // 원본이 없으면 검증 불가
  if (!parsedBookmarks) {
    missingArea.style.display = 'none';
    return;
  }

  try {
    var originalLinks = collectLinksWithPath(parsedBookmarks, '');
    var aiUrls = new Set(collectUrls(aiTree).map(normalizeUrl));
    missingBookmarks = originalLinks.filter(link => !aiUrls.has(normalizeUrl(link.url)));
  } catch (e) {
    missingArea.style.display = 'none';
    return;
  }

  missingArea.style.display = 'block';

  const originalCount = originalLinks.length;
  const aiCount = originalCount - missingBookmarks.length;

  if (missingBookmarks.length === 0) {
    headerEl.innerHTML = '<span class="badge-ok">누락 없음</span>';
    summaryEl.textContent = '원본 ' + originalCount + '개 북마크가 모두 포함되었다.';
    listEl.style.display = 'none';
    btnRow.style.display = 'none';
  } else {
    headerEl.innerHTML = '<span class="badge-warn">누락 ' + missingBookmarks.length + '개 발견</span>';
    summaryEl.textContent =
      '원본 ' + originalCount + '개 중 ' + aiCount + '개 포함, ' +
      missingBookmarks.length + '개 누락됨. 아래 목록을 AI에 전달하여 추가 분류를 요청한다.';

    listEl.style.display = 'block';
    listEl.innerHTML = missingBookmarks.map(item =>
      '<div class="item">' +
        '<span class="folder">' + escapeHtml(item.folder) + '</span><br>' +
        '<span class="title">' + escapeHtml(item.title) + '</span> ' +
        '<span class="url">' + escapeHtml(item.url) + '</span>' +
      '</div>'
    ).join('');

    btnRow.style.display = 'flex';
  }
}

function copyMissingMarkdown() {
  if (missingBookmarks.length === 0) return;

  const lines = [
    '직전에 출력한 개선된 북마크 구조에서 아래 ' + missingBookmarks.length + '개가 빠져 있다.',
    '',
    '# 작업',
    '아래 누락된 북마크를 직전 결과의 폴더 구조에 삽입하여, 전체 북마크 구조를 다시 출력한다.',
    '새로운 폴더를 만들지 말고 기존 폴더에 배치한다. 적절한 폴더가 없으면 가장 가까운 폴더에 넣는다.',
    '',
    '# 출력 형식',
    '직전과 동일한 마크다운 형식(## 폴더, - [제목](URL))으로 전체 구조를 다시 출력한다.',
    '',
    '# 누락된 북마크',
    ''
  ];
  for (const item of missingBookmarks) {
    lines.push('- [' + item.title + '](' + item.url + ')');
  }
  copyToClipboard(lines.join('\n'), 'missing-copy-feedback');
}

function downloadConvertedHtml() {
  if (!convertedHtml) return;
  const blob = new Blob([convertedHtml], { type: 'text/html;charset=utf-8' });
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = 'bookmarks_reorganized.html';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function copyConvertedHtml() {
  if (!convertedHtml) return;
  copyToClipboard(convertedHtml, 'convert-copy-feedback');
}

// ───────────────────────────────────────────
// ④ AI 입력 실시간 미리보기: 감지된 링크 수 표시
// ───────────────────────────────────────────
document.getElementById('ai-input').addEventListener('input', function () {
  const preview = document.getElementById('ai-input-preview');
  const text = this.value.trim();
  if (!text) {
    preview.textContent = '';
    return;
  }
  const linkPattern = /\[.*?\]\([^)]+\)/g;
  const matches = text.match(linkPattern);
  const count = matches ? matches.length : 0;
  preview.textContent = count > 0
    ? 'URL ' + count + '개 감지됨, 변환 가능'
    : '링크를 감지할 수 없음';
  preview.style.color = count > 0 ? '#2d8f47' : '#c62828';
});
