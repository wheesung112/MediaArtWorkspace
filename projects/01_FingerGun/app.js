// 공용 모듈 파일에서 함수들을 가져옵니다!
import { initHandTracking } from '../../shared/core.js';
import { getDistance3D, isFolded, drawDefaultSkeleton } from '../../shared/mathUtils.js';

const videoElement = document.querySelector('.input_video');
const canvasElement = document.querySelector('.output_canvas');
const canvasCtx = canvasElement.getContext('2d');
const loadingText = document.getElementById('loadingText');

let yHistory = [];
let lastShotTime = 0;
let particles = [];

// 스파크 파티클 생성 로직 (프로젝트 한정 디자인)
function fireShot(x, y) {
  const numParticles = 30;
  for(let i = 0; i < numParticles; i++) {
    particles.push({
      x: x, 
      y: y,
      vx: (Math.random() - 0.5) * 40,
      vy: (Math.random() - 0.5) * 40,
      life: 1.0, 
      color: `hsl(${Math.random() * 60 + 30}, 100%, 60%)`
    });
  }
}

// 매 프레임마다 불리는 렌더링 콜백 함수
function onDraw(results) {
  canvasCtx.save();
  canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);

  // 배경 웹캠
  canvasCtx.globalAlpha = 0.3;
  canvasCtx.drawImage(results.image, 0, 0, canvasElement.width, canvasElement.height);
  canvasCtx.globalAlpha = 1.0;

  if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
    for (const landmarks of results.multiHandLandmarks) {
      // 뼈대 그리기 (mathUtils.js 에서 가져온 공용 함수)
      drawDefaultSkeleton(canvasCtx, landmarks);

      const extIndex = !isFolded(landmarks, 8, 5);
      const extMiddle = !isFolded(landmarks, 12, 9);
      const foldedRing = isFolded(landmarks, 16, 13);
      const foldedPinky = isFolded(landmarks, 20, 17);
      
      const fingerDistance = getDistance3D(landmarks[8], landmarks[12]);
      const palmSize = getDistance3D(landmarks[0], landmarks[9]);
      const isAttached = fingerDistance < palmSize * 0.4;

      const isGunPose = extIndex && extMiddle && foldedRing && foldedPinky && isAttached;

      const indexTip = landmarks[8];
      yHistory.push(indexTip.y);
      if (yHistory.length > 5) yHistory.shift();

      if (isGunPose && yHistory.length === 5) {
        const jump = yHistory[0] - yHistory[4];
        
        if (jump > 0.04 && (Date.now() - lastShotTime) > 400) {
          fireShot(indexTip.x * canvasElement.width, indexTip.y * canvasElement.height);
          lastShotTime = Date.now();
          yHistory = [];
        }
      }

      if (isGunPose) {
        // 장전 시 불빛
        const x = landmarks[8].x * canvasElement.width;
        const y = landmarks[8].y * canvasElement.height;
        canvasCtx.beginPath();
        canvasCtx.arc(x, y, Math.random() * 15 + 10, 0, 2 * Math.PI);
        canvasCtx.fillStyle = '#00FFCC';
        canvasCtx.shadowColor = '#00FFCC';
        canvasCtx.shadowBlur = 30;
        canvasCtx.fill();
        canvasCtx.shadowBlur = 0;
      }
    }
  }

  // 파티클 업데이트 로직
  for (let i = particles.length - 1; i >= 0; i--) {
    let p = particles[i];
    p.x += p.vx;
    p.y += p.vy;
    p.vy += 1;
    p.vx *= 0.9;
    p.vy *= 0.9;
    p.life -= 0.03;
    
    canvasCtx.beginPath();
    canvasCtx.arc(p.x, p.y, Math.max(0, p.life * 12), 0, 2 * Math.PI);
    canvasCtx.fillStyle = p.color;
    canvasCtx.shadowColor = p.color;
    canvasCtx.shadowBlur = 10;
    canvasCtx.fill();
    canvasCtx.shadowBlur = 0; 
    
    if (p.life <= 0) particles.splice(i, 1);
  }

  canvasCtx.restore();
}

// === [가장 중요한 메인 구동] ===
// core.js의 초기화 함수를 가져옵니다. 
// 필요한 비디오 요소, 설정값, 그리기 함수(onDraw)만 던져주면 MediaPipe가 알아서 구동됩니다!
initHandTracking(videoElement, {
  loadingText: loadingText,
  maxNumHands: 2,
  width: 1280,
  height: 720
}, onDraw);
