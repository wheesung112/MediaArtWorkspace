/**
 * MediaPipe Holistic 초기화 전용 (얼굴 + 손 + 몸통 동시 추적)
 */
export function initHolisticTracking(videoElement, options, onDrawCallback) {
  const holistic = new Holistic({locateFile: (file) => {
    return `https://cdn.jsdelivr.net/npm/@mediapipe/holistic/${file}`;
  }});

  holistic.setOptions({
    modelComplexity: 1,
    smoothLandmarks: true,
    enableSegmentation: false,
    smoothSegmentation: false,
    refineFaceLandmarks: true, // 얼굴 468개 랜드마크 켜기
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5
  });

  holistic.onResults((results) => {
    if (options.loadingText) options.loadingText.style.display = 'none';
    onDrawCallback(results);
  });

  const camera = new Camera(videoElement, {
    onFrame: async () => {
      await holistic.send({image: videoElement});
    },
    width: options.width || 1280,
    height: options.height || 720
  });

  camera.start();

  return { holistic, camera };
}
