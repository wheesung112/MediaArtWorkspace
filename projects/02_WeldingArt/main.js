import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

import { initHandTracking } from '../../shared/core.js';
import { isFolded } from '../../shared/mathUtils.js';
import { vertexShader, fragmentShader } from './shaders.js';

const videoElement = document.querySelector('.input_video');
const canvasElement = document.querySelector('.output_canvas');

const scene = new THREE.Scene();
const aspect = 1280 / 720;
const camera = new THREE.OrthographicCamera(-aspect, aspect, 1, -1, 0.1, 10);
camera.position.z = 1;

const renderer = new THREE.WebGLRenderer({ canvas: canvasElement, antialias: true, alpha: true });
renderer.setSize(1280, 720);

// === 핑퐁 마스크 타겟 세팅 (시간에 따라 효과가 자라나도록 만들기 위함) ===
let maskTargetA = new THREE.WebGLRenderTarget(1280, 720, { type: THREE.FloatType, format: THREE.RGBAFormat });
let maskTargetB = new THREE.WebGLRenderTarget(1280, 720, { type: THREE.FloatType, format: THREE.RGBAFormat });

// 초기화
renderer.setClearColor(0x000000, 1);
renderer.setRenderTarget(maskTargetA); renderer.clear();
renderer.setRenderTarget(maskTargetB); renderer.clear();
renderer.setRenderTarget(null);

// 1. 마스크를 강제로 성장시키는 복제용 씬
const growScene = new THREE.Scene();
const growMat = new THREE.ShaderMaterial({
  uniforms: { 
    tDiffuse: { value: null },
    uTime: { value: 0 }
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `
    varying vec2 vUv; 
    uniform sampler2D tDiffuse;
    uniform float uTime;
    void main() { 
      vec4 tex = texture2D(tDiffuse, vUv);
      float melt = tex.r;
      float flame = tex.g;
      
      // 1. Melt 채널(지우개): 뚫린 구멍은 서서히 완전한 영상으로 확장됨
      if (melt > 0.01 && melt < 2.5) {
        melt += 0.012; 
      }
      
      // 2. Flame 채널: 위로 올라가지 않고 제자리에서 빠르게 식어 없어지도록 수정
      flame = flame * 0.85; 
      
      gl_FragColor = vec4(melt, flame, 0.0, 1.0);
    }
  `,
  depthWrite: false
});
growScene.add(new THREE.Mesh(new THREE.PlaneGeometry(aspect * 2, 2), growMat));

// 2. 손가락 궤적을 묻히는 브러시용 씬
const maskScene = new THREE.Scene();
const brushMat = new THREE.ShaderMaterial({
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `
    varying vec2 vUv;
    void main() {
      float d = distance(vUv, vec2(0.5));
      float meltAlpha = smoothstep(0.1, 0.0, d) * 0.2; 
      // G채널 (그라데이션 빛): 영역을 확 줄이고(0.25) 강도도 대폭 낮춰서(0.6) 중심이 뭉쳐 하얗게 타는 현상 방지
      float flameAlpha = smoothstep(0.25, 0.0, d) * 0.6; 
      
      gl_FragColor = vec4(meltAlpha, flameAlpha, 0.0, 1.0);
    }
  `,
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending 
});
// 캔버스는 불꽃 반경을 담기 위해 크게 하되, 지우개 알맹이는 셰이더 내에서 작게 쪼갬
const brushGeo = new THREE.PlaneGeometry(0.8, 0.8); 
const brushMesh = new THREE.Mesh(brushGeo, brushMat);
maskScene.add(brushMesh);

// === 메인 화면 출력 ===
const videoTexture = new THREE.VideoTexture(videoElement);
videoTexture.minFilter = THREE.LinearFilter;
videoTexture.magFilter = THREE.LinearFilter;

const mainMat = new THREE.ShaderMaterial({
  uniforms: {
    uTime: { value: 0 },
    tMask: { value: maskTargetA.texture },
    tVideo: { value: videoTexture },
    uVideoSize: { value: new THREE.Vector2(1280, 720) } // 비디오 해상도 보정용 유니폼
  },
  vertexShader: vertexShader,
  fragmentShader: fragmentShader
});
const planeMesh = new THREE.Mesh(new THREE.PlaneGeometry(aspect * 2, 2), mainMat);
scene.add(planeMesh);

// === 블룸 이펙트 ===
const renderScene = new RenderPass(scene, camera);
const bloomPass = new UnrealBloomPass(new THREE.Vector2(1280, 720), 1.5, 0.4, 0.85);
bloomPass.threshold = 1.0; 
bloomPass.strength = 1.8;
bloomPass.radius = 0.5;

const composer = new EffectComposer(renderer);
composer.addPass(renderScene);
composer.addPass(bloomPass);


let currentFingerPos = null;

function onDraw(results) {
  currentFingerPos = null;
  if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
    for (const landmarks of results.multiHandLandmarks) {
      const extIndex = !isFolded(landmarks, 8, 5);
      const foldedMiddle = isFolded(landmarks, 12, 9);
      const foldedRing = isFolded(landmarks, 16, 13);
      const foldedPinky = isFolded(landmarks, 20, 17);
      
      const isPointing = extIndex && foldedMiddle && foldedRing && foldedPinky;
      if (isPointing) currentFingerPos = landmarks[8];
    }
  }
}

// === 애니메이션 루프 ===
const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const delta = clock.getDelta();
  mainMat.uniforms.uTime.value += delta;
  growMat.uniforms.uTime.value += delta; // 오로라 흐름용 애니메이션 시간 추가
  
  // 비디오 준비 시 실제 영상 크기를 넘겨 마법처럼 비율 보정 실행!
  if (videoElement.readyState >= 2) {
    mainMat.uniforms.uVideoSize.value.set(videoElement.videoWidth, videoElement.videoHeight);
  }
  
  // --- [Ping-Pong 마스킹 핵심!] ---
  renderer.autoClear = false;
  
  // 1. 현재 (A)를 바탕으로 값을 1.0 이상으로 천천히 성장시켜서 (B)에 그립니다
  renderer.setRenderTarget(maskTargetB);
  growMat.uniforms.tDiffuse.value = maskTargetA.texture;
  renderer.render(growScene, camera);
  
  // 2. 새로운 손가락 위치가 감지되면 (B) 위에 브러시를 덧칠합니다 
  if (currentFingerPos) {
    const x = (currentFingerPos.x * 2.0 - 1.0) * aspect;
    const y = -(currentFingerPos.y * 2.0 - 1.0);
    brushMesh.position.set(x, y, 0);
    renderer.render(maskScene, camera); 
  }

  // 3. A와 B의 역할을 바꿉니다 (핑-퐁)
  let temp = maskTargetA;
  maskTargetA = maskTargetB;
  maskTargetB = temp;
  
  // 메인 셰이더에는 완성된 최신 도화지(A)를 넘겨줍니다.
  mainMat.uniforms.tMask.value = maskTargetA.texture;

  // ------------------------------

  // 4. 최종 메인 화면 렌더링
  renderer.setRenderTarget(null);
  renderer.autoClear = true; 
  composer.render();
}
animate();

initHandTracking(videoElement, {
  loadingText: document.getElementById('loadingText'),
  width: 1280,
  height: 720,
  maxNumHands: 1
}, onDraw);
