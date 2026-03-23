import * as THREE from 'three';
import { initFaceTracking } from '../../shared/faceCore.js';

const videoElement = document.querySelector('.input_video');
const canvasElement = document.querySelector('.output_canvas');

// === Three.js 초기화 ===
const scene = new THREE.Scene();
const aspect = 1280 / 720;
const camera = new THREE.OrthographicCamera(-aspect, aspect, 1, -1, 0.1, 10);
camera.position.z = 1;

const renderer = new THREE.WebGLRenderer({ canvas: canvasElement, antialias: true, alpha: true });
renderer.setSize(1280, 720);

// 웹캠 배경 처리
const videoTexture = new THREE.VideoTexture(videoElement);
videoTexture.minFilter = THREE.LinearFilter;
videoTexture.magFilter = THREE.LinearFilter;

const bgGeo = new THREE.PlaneGeometry(aspect * 2, 2);
const bgMat = new THREE.MeshBasicMaterial({ map: videoTexture, depthWrite: false });
const bgMesh = new THREE.Mesh(bgGeo, bgMat);
bgMesh.position.z = -1; // 3D 포스트잇이 뒤로 파묻히지 않게 배경을 맨 뒤로 밉니다.
scene.add(bgMesh);

// === 포스트잇 3D 데이터 설정 ===
const createPostItMaterial = (col) => new THREE.MeshBasicMaterial({ 
  color: col,
  side: THREE.DoubleSide // 3D 회전으로 인해 뒷면이 보여도 투명하게 사라지지 않게 처리
});
const postItGeo = new THREE.PlaneGeometry(0.2, 0.2); 

// 볼에 붙은 포스트잇은 바깥쪽을 바라봐야 자연스럽게 얼굴에 "착" 붙은 3D 입체감을 줍니다.
const postItData = [
  { id: 'forehead', idx: 10, maxHp: 1.0, color: 0xffeb3b, rot: new THREE.Euler(0, 0, 0) }, 
  // 광대 옆면에 확실하게 붙어있는 느낌을 주기 위해 각도를 대폭 꺾습니다 (약 57도)
  { id: 'leftCheek', idx: 345, maxHp: 1.8, color: 0xff9800, rot: new THREE.Euler(0, 1.0, 0) }, 
  { id: 'rightCheek', idx: 116, maxHp: 1.5, color: 0x4caf50, rot: new THREE.Euler(0, -1.0, 0) }, 
  { id: 'nose', idx: 5, maxHp: 0.7, color: 0x03a9f4, rot: new THREE.Euler(0, 0, 0) }, 
  { id: 'chin', idx: 152, maxHp: 1.2, color: 0xe91e63, rot: new THREE.Euler(0.2, 0, 0) }, 
];

let items = [];

postItData.forEach(data => {
  const mesh = new THREE.Mesh(postItGeo, createPostItMaterial(data.color));
  scene.add(mesh);
  items.push({
    mesh: mesh,
    landmarkIdx: data.idx,
    hp: data.maxHp,
    isFallen: false,
    baseQuat: new THREE.Quaternion().setFromEuler(data.rot), // 부위별 자연스러운 베이스 각도 저장
    velocity: { x: 0, y: 0 }, 
    spin: { x: 0, y: 0, z: 0 } 
  });
});

// === 3D 공간 벡터 변환 및 3D 회전(Rotation) 계산 로직 ===
let previousNose = null;
let currentShakeIntensity = 0;

function onDraw(results) {
  if (results.multiFaceLandmarks && results.multiFaceLandmarks.length > 0) {
    const landmarks = results.multiFaceLandmarks[0]; 
    
    // 3D 좌표 변환 헬퍼 (MediaPipe의 Z값과 화면 비율을 모두 반영하여 완벽한 입체 공간을 구성)
    const getVec = (idx) => new THREE.Vector3(
      (landmarks[idx].x * 2.0 - 1.0) * aspect,
      -(landmarks[idx].y * 2.0 - 1.0),
      -landmarks[idx].z * aspect * 2.0 
    );

    // --- 1. 흔들림(속도) 연산 ---
    const nose = landmarks[5];
    if (!previousNose) previousNose = { x: nose.x, y: nose.y, z: nose.z };
    
    const dx = nose.x - previousNose.x;
    const dy = nose.y - previousNose.y;
    const dz = nose.z - previousNose.z;
    const speed = Math.sqrt(dx*dx + dy*dy + dz*dz) * 100.0;
    
    currentShakeIntensity = currentShakeIntensity * 0.6 + speed * 0.4;
    previousNose = { x: nose.x, y: nose.y, z: nose.z };

    // --- 2. 🌟 얼굴의 "3D 회전 축(Rotation Matrix)" 수학적 추출 🌟 ---
    // 얼굴 가장자리 4개의 점을 이용해 X, Y, Z 직교 축을 만들어냅니다.
    const ptRight = getVec(454); // 사용자 뺨 우측
    const ptLeft = getVec(234);  // 사용자 뺨 좌측
    const ptTop = getVec(10);    // 이마 맨 위
    const ptBottom = getVec(152);// 턱 끝

    // X축: 왼쪽 뺨에서 오른쪽 뺨을 잇는 가로 축
    const xAxis = new THREE.Vector3().subVectors(ptLeft, ptRight).normalize();
    // Y축: 턱에서 이마로 올라가는 세로 축
    const yAxis = new THREE.Vector3().subVectors(ptTop, ptBottom).normalize();
    // Z축: 두 벡터의 십자가에 수직으로 꽂히는 정면 축(Forward)
    const zAxis = new THREE.Vector3().crossVectors(xAxis, yAxis).normalize();
    yAxis.crossVectors(zAxis, xAxis).normalize(); // 정확한 90도 직교화 보정 완료!

    // 위 세 축을 이용해 "얼굴이 어느 쪽을 보고 있는지" 3D 사원수(Quaternion)로 변환
    const headRotMatrix = new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis);
    const headQuaternion = new THREE.Quaternion().setFromRotationMatrix(headRotMatrix);

    // --- 3. 포스트잇에 Z축 깊이와 3D 각도 적용 ---
    items.forEach(item => {
      if (!item.isFallen) {
        
        // Z축 깊이까지 온전히 가져옵니다. (얼굴 굴곡에 따라 이마가 튀어나오고 턱이 들어간 입체감이 생깁니다)
        const pos = getVec(item.landmarkIdx);
        
        // 🌟 핵심 마법: 얼굴의 회전 각도를 포스트잇에 똑같이 복사한 뒤, 부위별(볼, 턱 등) 고유의 회전 각도를 합성합니다.
        item.mesh.quaternion.copy(headQuaternion).multiply(item.baseQuat);

        // 피부 파묻힘(뒤통수 착시) 방지를 위해 포스트잇이 바라보는 정면(Z축)으로 0.03만큼 띄워줍니다.
        const normalOffset = new THREE.Vector3(0, 0, 0.03).applyQuaternion(item.mesh.quaternion);

        if (currentShakeIntensity > 0.8) {
           item.hp -= currentShakeIntensity * 0.05; 
           const jitter = Math.max(0, currentShakeIntensity * 0.015);
           // 덜덜 떨릴 때 깊이(Z)값도 유지합니다
           item.mesh.position.set(
              pos.x + normalOffset.x + (Math.random() - 0.5) * jitter, 
              pos.y + normalOffset.y + (Math.random() - 0.5) * jitter, 
              pos.z + normalOffset.z
           );
        } else {
           item.mesh.position.copy(pos).add(normalOffset); // 흔들리지 않으면 굴곡진 부위에 착! 달라붙어 있음
        }
        
        // 체력 방전 시 추락 로직
        if (item.hp <= 0) {
           item.isFallen = true;
           item.velocity = { 
               x: (Math.random() - 0.5) * 0.08, 
               y: 0.03 + Math.random() * 0.05
           };
           item.spin = {
               x: (Math.random() - 0.5) * 0.3,
               y: (Math.random() - 0.5) * 0.3,
               z: (Math.random() - 0.5) * 0.3
           };
        }
      }
    }); 
  }
}

// === 물리엔진 및 렌더링 루프 ===
function animate() {
  requestAnimationFrame(animate);
  
  items.forEach(item => {
     if (item.isFallen) {
        item.mesh.position.x += item.velocity.x;
        item.mesh.position.y += item.velocity.y;
        item.velocity.y -= 0.005; // 중력이 바닥으로 당김
        
        item.mesh.rotation.x += item.spin.x;
        item.mesh.rotation.y += item.spin.y;
        item.mesh.rotation.z += item.spin.z;
     }
  });

  renderer.render(scene, camera);
}
animate();

// 구동
initFaceTracking(videoElement, {
  loadingText: document.getElementById('loadingText'),
  maxNumFaces: 1
}, onDraw);
