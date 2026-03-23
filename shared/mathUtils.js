/**
 * 수학적 계산 거리 계산 및 자주 쓰는 유틸리티 함수 모음입니다.
 */

// 3D 공간 상에서 두 점 사이의 거리를 구하는 유틸리티 함수
export function getDistance3D(p1, p2) {
  return Math.sqrt(Math.pow(p1.x - p2.x, 2) + Math.pow(p1.y - p2.y, 2) + Math.pow(p1.z - p2.z, 2));
}

// 손가락이 접혔는지 파악하는 함수
export function isFolded(landmarks, tipIdx, mcpIdx) {
  const palmSize = getDistance3D(landmarks[0], landmarks[9]);
  const fingerLength = getDistance3D(landmarks[tipIdx], landmarks[mcpIdx]);
  // 손가락 길이가 손바닥 크기의 70% 미만이면 접힌 것으로 간주합니다!
  return fingerLength < palmSize * 0.7; 
}

// 기본 점/선 뼈대를 캔버스에 그려주는 헬퍼 함수
// (Google MediaPipe 내장 함수인 drawConnectors와 drawLandmarks가 필요합니다)
export function drawDefaultSkeleton(canvasCtx, landmarks) {
  if (typeof drawConnectors !== 'undefined') {
    drawConnectors(canvasCtx, landmarks, HAND_CONNECTIONS, {color: '#00FFCC', lineWidth: 2});
    drawLandmarks(canvasCtx, landmarks, {color: '#FF007F', lineWidth: 1, radius: 2});
  }
}
