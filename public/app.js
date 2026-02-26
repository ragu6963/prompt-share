const socket = io();

// UI Elements
const els = {
    downloadPdfBtn: document.getElementById('downloadPdfBtn'),
    downloadTxtBtn: document.getElementById('downloadTxtBtn'),
    themeToggleBtn: document.getElementById('themeToggleBtn'),
    themeIcon: document.getElementById('themeIcon'),
    adminBtn: document.getElementById('adminBtn'),
    statusAlert: document.getElementById('statusAlert'),
    adminHeaderInfo: document.getElementById('adminHeaderInfo'),
    adminTools: document.getElementById('adminTools'),
    currentUrlTxt: document.getElementById('currentUrlTxt'),
    copyInviteBtn: document.getElementById('copyInviteBtn'),
    messageList: document.getElementById('messageList'),
    emptyState: document.getElementById('emptyState'),
    adminPanel: document.getElementById('adminPanel'),
    promptInput: document.getElementById('promptInput'),
    sendBtn: document.getElementById('sendBtn'),
    rotateUrlBtn: document.getElementById('rotateUrlBtn'),
    clearAllBtn: document.getElementById('clearAllBtn'),
    loginModal: document.getElementById('loginModal'),
    passwordInput: document.getElementById('passwordInput'),
    loginBtn: document.getElementById('loginBtn'),
    cancelLoginBtn: document.getElementById('cancelLoginBtn')
};

// State
let isAdmin = false;
let currentMessages = [];

// Helper: Get roomId from Path
function getRoomIdFromUrl() {
    const pathParts = window.location.pathname.split('/');
    if (pathParts[1] === 'live' && pathParts[2]) {
        return pathParts[2];
    }
    return null;
}

// Initialization connect
socket.on('connect', () => {
    const roomId = getRoomIdFromUrl();
    if (roomId) {
        // 방에 조인 요청
        socket.emit('joinRoom', { roomId });
    } else {
        // 일반 접근 (루트), 강사 로그인 전에는 리스트를 볼 수 없음
    }
});

// Socket Events
socket.on('invalidRoom', () => {
    showDisconnected('잘못된 접근이거나 세션이 만료되었습니다.');
});

socket.on('roomRotated', () => {
    if(!isAdmin) {
        showDisconnected('확인된 교육장 주소가 변경되었습니다. 새 주소를 강사님께 요청하세요.');
    }
});

socket.on('sessionExpired', () => {
    if(!isAdmin) {
        showDisconnected('세션이 6시간 비활성화되어 만료되었습니다.');
    } else {
        alert('세션이 비활성화되어 초기화되었습니다. 권한은 유지됩니다.');
        currentMessages = [];
        renderMessages();
    }
});

socket.on('initMessages', (messages) => {
    currentMessages = messages || [];
    renderMessages();
});

socket.on('newMessage', (msgObj) => {
    currentMessages.push(msgObj);
    renderMessages();
    // 최신순이므로 맨 위로 스크롤
    els.messageList.scrollTop = 0;
});

socket.on('messagesCleared', () => {
    currentMessages = [];
    renderMessages();
});

socket.on('messageDeleted', (msgId) => {
    currentMessages = currentMessages.filter(m => m.id !== msgId);
    renderMessages();
});

socket.on('urlRotated', (newRoomId) => {
    els.currentUrlTxt.textContent = `/live/${newRoomId}`;
    history.replaceState(null, '', `/live/${newRoomId}`);
});


// DOM Events
// 1. Download Actions
els.downloadPdfBtn.addEventListener('click', () => {
    if (currentMessages.length === 0) {
        alert('다운로드할 프롬프트가 없습니다.');
        return;
    }

    const today = new Date();
    const dateStr = today.getFullYear() + String(today.getMonth() + 1).padStart(2, '0') + String(today.getDate()).padStart(2, '0');
    
    // PDF 변환을 위한 임시 DOM 요소 생성
    const container = document.createElement('div');
    container.style.padding = '20px';
    container.style.fontFamily = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", "Pretendard", sans-serif';
    container.style.color = '#1D1D1F';
    container.style.backgroundColor = '#FFFFFF';

    currentMessages.slice().reverse().forEach((msg, index) => {
        const itemDiv = document.createElement('div');
        itemDiv.style.marginBottom = '20px';
        itemDiv.style.padding = '15px';
        itemDiv.style.border = '1px solid #D2D2D7';
        itemDiv.style.borderRadius = '8px';
        // PDF 페이지 분할 시 항목이 잘리지 않도록 설정
        itemDiv.style.pageBreakInside = 'avoid';

        const contentDiv = document.createElement('div');
        contentDiv.innerHTML = marked.parse(`\`\`\`markdown\n${msg.text}\n\`\`\``);
        
        // 내부 pre 요소 스타일링 (PDF에서 깔끔하게 보이도록)
        const pres = contentDiv.querySelectorAll('pre');
        pres.forEach(pre => {
            pre.style.backgroundColor = 'transparent';
            pre.style.padding = '0';
            pre.style.borderRadius = '0';
            pre.style.overflowX = 'hidden';
            pre.style.whiteSpace = 'pre-wrap'; // 긴 텍스트 줄바꿈 보장
            pre.style.wordBreak = 'break-word';
            pre.style.fontSize = '12px';
            pre.style.lineHeight = '1.6';
            pre.style.margin = '0';
        });

        itemDiv.appendChild(contentDiv);
        container.appendChild(itemDiv);
    });

    const opt = {
        margin:       10,
        filename:     `prompts_${dateStr}.pdf`,
        image:        { type: 'jpeg', quality: 0.98 },
        html2canvas:  { scale: 2, useCORS: true },
        jsPDF:        { unit: 'mm', format: 'a4', orientation: 'portrait' }
    };

    // 다운로드 중 버튼 상태 변경
    const originalContent = els.downloadPdfBtn.innerHTML;
    els.downloadPdfBtn.innerHTML = '<span style="font-size:0.7rem; font-weight:bold;">PDF...</span>';
    els.downloadPdfBtn.disabled = true;

    html2pdf().set(opt).from(container).save().then(() => {
        // 원래 버튼 상태로 복구
        els.downloadPdfBtn.innerHTML = originalContent;
        els.downloadPdfBtn.disabled = false;
    });
});

els.downloadTxtBtn.addEventListener('click', () => {
    if (currentMessages.length === 0) {
        alert('다운로드할 프롬프트가 없습니다.');
        return;
    }
    
    let txtContent = '';
    currentMessages.slice().reverse().forEach((msg, index) => {
        txtContent += `[프롬프트 ${index + 1}]\n${msg.text}\n\n----------------------------------------\n\n`;
    });
    
    const blob = new Blob([txtContent], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    
    const today = new Date();
    const dateStr = today.getFullYear() + String(today.getMonth() + 1).padStart(2, '0') + String(today.getDate()).padStart(2, '0');
    
    a.download = `prompts_${dateStr}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
});

function updateThemeIcon() {
    const currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
    if (currentTheme === 'dark') {
        // 달 모양 아이콘 (Dark)
        els.themeIcon.innerHTML = '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>';
    } else {
        // 해 모양 아이콘 (Light)
        els.themeIcon.innerHTML = '<circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>';
    }
}
// 초기 아이콘 세팅
updateThemeIcon();

els.themeToggleBtn.addEventListener('click', () => {
    const currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('theme', newTheme);
    updateThemeIcon();
});

// 2. Admin Login
els.adminBtn.addEventListener('click', () => {
    if (isAdmin) return;
    els.loginModal.classList.remove('hidden');
    els.passwordInput.focus();
});

els.cancelLoginBtn.addEventListener('click', () => {
    els.loginModal.classList.add('hidden');
    els.passwordInput.value = '';
});

els.loginBtn.addEventListener('click', attemptLogin);
els.passwordInput.addEventListener('keyup', (e) => {
    if(e.key === 'Enter') attemptLogin();
});

function attemptLogin() {
    const pw = els.passwordInput.value;
    socket.emit('authenticate', pw, (response) => {
        if (response.success) {
            isAdmin = true;
            els.loginModal.classList.add('hidden');
            els.adminBtn.classList.add('hidden');
            els.adminHeaderInfo.classList.remove('hidden');
            els.adminTools.classList.remove('hidden');
            els.adminPanel.classList.remove('hidden');
            els.currentUrlTxt.textContent = `/live/${response.currentRoomPath}`;
            
            // history update
            if(window.location.pathname !== `/live/${response.currentRoomPath}`) {
                history.replaceState(null, '', `/live/${response.currentRoomPath}`);
            }

            currentMessages = response.currentMessages;
            renderMessages();
        } else {
            alert('비밀번호가 일치하지 않습니다.');
        }
    });
}

// Admin Actions
// 자동 높이 조절 기능
els.promptInput.addEventListener('input', function() {
    this.style.height = 'auto'; // 초기화하여 스크롤 높이 재계산
    this.style.height = this.scrollHeight + 'px';
});

els.promptInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault(); // 기본 줄바꿈 방지
        els.sendBtn.click(); // 전송 버튼 클릭 효과
    }
});

els.sendBtn.addEventListener('click', () => {
    const text = els.promptInput.value.trim();
    if (!text) return;
    socket.emit('sendMessage', text);
    
    // 내용 및 높이 초기화
    els.promptInput.value = '';
    els.promptInput.style.height = 'auto';
    els.promptInput.focus();
});

els.clearAllBtn.addEventListener('click', () => {
    if(confirm('모든 프롬프트를 삭제하시겠습니까? 학생들의 화면에서도 모두 지워집니다.')) {
        socket.emit('clearMessages');
    }
});

els.rotateUrlBtn.addEventListener('click', () => {
    if(confirm('접속 URL을 갱신하시겠습니까? 기존에 접속 중인 학생들의 연결이 차단됩니다.')) {
        socket.emit('rotateUrl');
    }
});

els.copyInviteBtn.addEventListener('click', () => {
    const fullUrl = `${window.location.origin}${els.currentUrlTxt.textContent}`;
    navigator.clipboard.writeText(fullUrl).then(() => {
        alert('초대 링크가 복사되었습니다!');
    });
});

// Render
function renderMessages() {
    els.messageList.innerHTML = '';
    
    if (currentMessages.length === 0) {
        els.emptyState.classList.remove('hidden');
        return;
    }
    
    els.emptyState.classList.add('hidden');
    
    currentMessages.slice().reverse().forEach((msg) => {
        const wrapperDiv = document.createElement('div');
        wrapperDiv.className = 'message-wrapper';

        const div = document.createElement('div');
        div.className = 'message-item';
        
        const contentDiv = document.createElement('div');
        contentDiv.className = 'message-content';
        // XSS 취약점이 있을 수 있지만 MVP에서는 marked 기본 허용
        contentDiv.innerHTML = marked.parse(`\`\`\`text\n${msg.text}\n\`\`\``);
        
        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'message-actions';
        
        const copyBtn = document.createElement('button');
        copyBtn.className = 'btn btn-sm btn-outline';
        copyBtn.textContent = '복사';
        copyBtn.onclick = () => {
            navigator.clipboard.writeText(msg.text).then(() => {
               const original = copyBtn.textContent;
               copyBtn.textContent = '복사됨 ✔';
               setTimeout(()=> copyBtn.textContent = original, 2000);
            });
        };
        actionsDiv.appendChild(copyBtn);
        
        if (isAdmin) {
            const delBtn = document.createElement('button');
            delBtn.className = 'btn btn-sm btn-danger';
            delBtn.textContent = '삭제';
            delBtn.onclick = () => {
                socket.emit('deleteMessage', msg.id);
            };
            actionsDiv.appendChild(delBtn);
        }
        
        div.appendChild(contentDiv);
        div.appendChild(actionsDiv);
        
        wrapperDiv.appendChild(div);
        
        els.messageList.appendChild(wrapperDiv);
    });
}

// Helpers
function showDisconnected(msg) {
    socket.disconnect(); // 소켓 강제 해제
    els.statusAlert.textContent = msg;
    els.statusAlert.classList.remove('hidden');
    
    els.adminPanel.classList.add('hidden');
    if(els.adminHeaderInfo) els.adminHeaderInfo.classList.add('hidden');
    if(els.adminTools) els.adminTools.classList.add('hidden');
    
    els.messageList.innerHTML = '';
    els.emptyState.classList.remove('hidden');
    els.emptyState.textContent = '연결이 해제되었습니다.';
}
