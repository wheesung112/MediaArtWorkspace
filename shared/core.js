/**
 * MediaPipe Hands 초기화 및 웹캠 연동을 담당하는 핵심 모듈입니다.
 * 이 코드는 모든 미디어아트 프로젝트에서 공유해서 사용합니다.
 */
export function initHandTracking(videoElement, options, onDrawCallback) {
  // 1. MediaPipe 모델 세팅
  const hands = new Hands({locateFile: (file) => {
    return `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`;
  }});

  hands.setOptions({
    maxNumHands: options.maxNumHands || 2,
    modelComplexity: options.modelComplexity || 1,
    minDetectionConfidence: 0.6,
    minTrackingConfidence: 0.5
  });

  // 2. 프레임마다 인식된 결과를 onDrawCallback 이라는 밖에서 만든 함수로 전달!
  hands.onResults((results) => {
    if (options.loadingText) options.loadingText.style.display = 'none';
    onDrawCallback(results);
  });

  // 3. 카메라 세팅 및 시작
  const camera = new Camera(videoElement, {
    onFrame: async () => {
      await hands.send({image: videoElement});
    },
    width: options.width || 1280,
    height: options.height || 720
  });

  camera.start();

  return { hands, camera }; // 필요할 경우 외부에서 끌어다 쓰도록 객체 반환
}
