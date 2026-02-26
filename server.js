const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
// 배포 환경을 위한 프록시 신뢰 설정 (Heroku, NGINX 등)
app.set('trust proxy', 1);

const server = http.createServer(app);

// Socket.io 배포 최적화 설정
const io = new Server(server, {
  cors: {
    origin: '*', // 허용할 도메인 지정 권장 (현재는 모두 허용)
    methods: ['GET', 'POST']
  },
  pingTimeout: 60000,   // 모바일 등 환경에서 연결 끊김 방지
  pingInterval: 25000
});

// 환경 변수 또는 하드코딩된 서버 비밀번호 (MVP 용)
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '1234';

// 메모리 상태 저장 (단일 룸)
let currentRoomPath = crypto.randomBytes(4).toString('hex'); // 초기 랜덤 URL 경로
let currentMessages = [];
let lastActivityTime = Date.now();
let cleanupTimer = null;

// 6시간 (밀리초)
const CLEANUP_INTERVAL = 6 * 60 * 60 * 1000;

function resetInactivityTimer() {
  lastActivityTime = Date.now();
  if (cleanupTimer) clearTimeout(cleanupTimer);
  
  cleanupTimer = setTimeout(() => {
    // 6시간 무활동 시 초기화
    currentMessages = [];
    currentRoomPath = crypto.randomBytes(4).toString('hex');
    io.emit('sessionExpired'); // 모든 클라이언트에게 만료 알림
    console.log('세션이 장기간 비활성화되어 초기화되었습니다.');
  }, CLEANUP_INTERVAL);
}

// 초기 타이머 시작
resetInactivityTimer();

// 정적 파일 제공 (public 폴더)
app.use(express.static(path.join(__dirname, 'public')));

// 가변 경로 라우팅 - 어떤 /live/:id 경로든 index.html을 반환
app.get('/live/:roomId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 루트로 오면 현재 라이브 경로로 리다이렉트 (테스트용)
// 실제 서비스에서는 강사만 새 경로를 알 수 있어야 하므로 이 라우트는 제거하거나 강사 로그인 페이지로 쓰는 것이 좋습니다.
// MVP에서는 단순화를 위해 강사용 접속 페이지 역할을 하도록 index.html을 줍니다.
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

io.on('connection', (socket) => {
  
  // 클라이언트가 연결되자마자 방 입장 요청을 보냄
  socket.on('joinRoom', ({ roomId }) => {
    // 강사 권한이 이미 연결된 소켓인 경우 (관리자 모드 활성화 상태)
    if (socket.isAdmin) return;

    if (roomId !== currentRoomPath) {
      // 구버전 또는 잘못된 URL인 경우
      socket.emit('invalidRoom');
      return;
    }
    
    // 정상 방 설정
    socket.join(currentRoomPath);
    socket.emit('initMessages', currentMessages);
  });

  // 강사 인증
  socket.on('authenticate', (password, callback) => {
    if (password === ADMIN_PASSWORD) {
      socket.isAdmin = true;
      callback({ success: true, currentRoomPath, currentMessages });
    } else {
      callback({ success: false, message: '비밀번호가 틀렸습니다.' });
    }
  });

  // 강사 전용 - 메시지 전송
  socket.on('sendMessage', (message) => {
    if (!socket.isAdmin) return;
    
    const msgObj = { id: Date.now(), text: message };
    currentMessages.push(msgObj);
    resetInactivityTimer();
    
    // 현재 유효한 방에 접속중인 다른 시청자(학생)에게 메시지 전송
    socket.to(currentRoomPath).emit('newMessage', msgObj);
    // 강사 본인에게도 전달 (이중 수신 방지: socket.to는 본인 제외 전송)
    socket.emit('newMessage', msgObj);
  });

  // 강사 전용 - URL 갱신
  socket.on('rotateUrl', () => {
    if (!socket.isAdmin) return;
    
    // 1. 기존 연결된 학생들에게 연결 해제 알림
    io.to(currentRoomPath).emit('roomRotated');
    
    // 2. 새로운 경로로 변경
    currentRoomPath = crypto.randomBytes(4).toString('hex');
    
    // (선택사항) URL 갱신 시 기존 메시지 삭제 여부. 현재는 요구사항에서 유지/삭제 선택 가능이라 했으나 기본 유지로 구현.
    // currentMessages = [];
    
    resetInactivityTimer();
    
    // 3. 강사에게 새 경로 전달
    socket.emit('urlRotated', currentRoomPath);
  });

  // 강사 전용 - 메시지 전체 초기화
  socket.on('clearMessages', () => {
    if (!socket.isAdmin) return;
    
    currentMessages = [];
    resetInactivityTimer();
    
    socket.to(currentRoomPath).emit('messagesCleared');
    socket.emit('messagesCleared');
  });
  
  // 강사 전용 - 특정 메시지 삭제
  socket.on('deleteMessage', (msgId) => {
     if (!socket.isAdmin) return;
     
     currentMessages = currentMessages.filter(m => m.id !== msgId);
     resetInactivityTimer();
     
     socket.to(currentRoomPath).emit('messageDeleted', msgId);
     socket.emit('messageDeleted', msgId);
  });

});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] 서버가 시작되었습니다. 포트: ${PORT}`);
  console.log(`[${new Date().toISOString()}] 현재 접속 URL 경로: /live/${currentRoomPath}`);
  
  if (ADMIN_PASSWORD === '1234') {
    console.log(`[${new Date().toISOString()}] ⚠️ ️경고: 기본 환경 비밀번호가 사용되었습니다. 배포 시 ADMIN_PASSWORD 환경변수를 지정하세요.`);
  }
});

// 배포 시 우아한 종료 (Graceful Shutdown)
function gracefulShutdown() {
  console.log(`[${new Date().toISOString()}] 종료 신호를 받았습니다. 서버를 안전하게 종료합니다.`);
  if (cleanupTimer) clearTimeout(cleanupTimer);
  server.close(() => {
    console.log(`[${new Date().toISOString()}] HTTP 서버 종료 완료.`);
    process.exit(0);
  });
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
