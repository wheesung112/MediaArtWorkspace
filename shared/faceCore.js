/**
 * MediaPipe Face Mesh 초기화 및 구동을 담당하는 전용 핵심 모듈입니다.
 */
export function initFaceTracking(videoElement, options, onDrawCallback) {
  const faceMesh = new FaceMesh({locateFile: (file) => {
    return `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`;
  }});

  faceMesh.setOptions({
    maxNumFaces: options.maxNumFaces || 1,
    refineLandmarks: true, // 눈과 입술 주변의 세밀한 랜드마크 468개 활성화
    minDetectionConfidence: 0.6,
    minTrackingConfidence: 0.6
  });

  faceMesh.onResults((results) => {
    if (options.loadingText) options.loadingText.style.display = 'none';
    onDrawCallback(results);
  });

  const camera = new Camera(videoElement, {
    onFrame: async () => {
      await faceMesh.send({image: videoElement});
    },
    // 화면 크기를 브라우저가 알아서 꽉 채우도록 크기 지정 생략
  });

  camera.start();

  return { faceMesh, camera };
}
