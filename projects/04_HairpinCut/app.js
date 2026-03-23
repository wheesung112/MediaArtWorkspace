import * as THREE from 'three';
import { initHolisticTracking } from '../../shared/holisticCore.js';
import { getDistance3D, isFolded } from '../../shared/mathUtils.js';

const videoElement = document.querySelector('.input_video');
const canvasElement = document.querySelector('.output_canvas');

const debugFace = document.getElementById('debugFace');
const debugHand = document.getElementById('debugHand');
const debugGesture = document.getElementById('debugGesture');
const debugLog = document.getElementById('debugLog');

const scene = new THREE.Scene();
const aspect = 1280 / 720;
const camera = new THREE.OrthographicCamera(-aspect, aspect, 1, -1, 0.1, 10);
camera.position.z = 1;

const renderer = new THREE.WebGLRenderer({ canvas: canvasElement, antialias: true, alpha: true });
renderer.setSize(1280, 720);

const videoTexture = new THREE.VideoTexture(videoElement);
videoTexture.minFilter = THREE.LinearFilter;
videoTexture.magFilter = THREE.LinearFilter;
const bgGeo = new THREE.PlaneGeometry(aspect * 2, 2);
const bgMat = new THREE.MeshBasicMaterial({ map: videoTexture, depthWrite: false });
const bgMesh = new THREE.Mesh(bgGeo, bgMat);
bgMesh.position.z = -1;
bgMesh.renderOrder = -1; 
scene.add(bgMesh);

// === 가위질 타겟 실제 3D Mesh 색종이 ===

const paperGroup = new THREE.Group();
paperGroup.position.set(0, 0, 0); 
scene.add(paperGroup);

const paperMat = new THREE.MeshBasicMaterial({ 
  color: 0xff4081, side: THREE.DoubleSide
});
const sourcePaper = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.8), paperMat);
// 더 촘촘한 정점을 보기 위해 세그먼트를 많이 나눠서 시작합니다.
sourcePaper.geometry = new THREE.PlaneGeometry(0.8, 0.8, 10, 10);
paperGroup.add(sourcePaper); 

const cutPieces = [];
let globalFaceCenter = new THREE.Vector3();
let globalHeadQuat = new THREE.Quaternion();

// 💡 새로운 로직: 폴리곤 자르기용 Clipper 변수 설정
const CLIP_SCALE = 10000;
// 초기 도화지 -0.4 ~ 0.4 크기의 다각형
let mainPaperPaths = [[
  {X: -4000, Y: -4000}, {X: 4000, Y: -4000}, {X: 4000, Y: 4000}, {X: -4000, Y: 4000}
]];

function extractShapes(polytree) {
    const list = [];
    const childs = typeof polytree.Childs === 'function' ? polytree.Childs() : polytree.Childs;
    if (!childs || childs.length === 0) return list;
    
    for (let i = 0; i < childs.length; i++) {
        const outerNode = childs[i];
        const shape = new THREE.Shape();
        const outerPath = typeof outerNode.Contour === 'function' ? outerNode.Contour() : outerNode.Contour;
        
        if (!outerPath || outerPath.length === 0) continue;
        
        shape.moveTo(outerPath[0].X / CLIP_SCALE, outerPath[0].Y / CLIP_SCALE);
        for (let j = 1; j < outerPath.length; j++) {
            shape.lineTo(outerPath[j].X / CLIP_SCALE, outerPath[j].Y / CLIP_SCALE);
        }
        
        const holes = typeof outerNode.Childs === 'function' ? outerNode.Childs() : outerNode.Childs;
        const allPaths = [outerPath];
        
        if (holes && holes.length > 0) {
            for (let k = 0; k < holes.length; k++) {
                const holeNode = holes[k];
                const holePath = typeof holeNode.Contour === 'function' ? holeNode.Contour() : holeNode.Contour;
                if (!holePath || holePath.length === 0) continue;
                
                const holeShape = new THREE.Path();
                holeShape.moveTo(holePath[0].X / CLIP_SCALE, holePath[0].Y / CLIP_SCALE);
                for (let h = 1; h < holePath.length; h++) {
                    holeShape.lineTo(holePath[h].X / CLIP_SCALE, holePath[h].Y / CLIP_SCALE);
                }
                shape.holes.push(holeShape);
                allPaths.push(holePath);
            }
        }
        
        list.push({
            area: Math.abs(ClipperLib.Clipper.Area(outerPath)),
            shape: shape,
            paths: allPaths
        });
    }
    return list;
}


// 시각적 디버깅 마커 (와이어프레임 구체는 요청에 의해 제거)

const scissorLineMat = new THREE.LineBasicMaterial({ color: 0x00ff00, linewidth: 5 });
const scissorLineGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
const scissorLine = new THREE.Line(scissorLineGeo, scissorLineMat);
scissorLine.visible = false;
scene.add(scissorLine);

const cutMarks = new THREE.Group();
scene.add(cutMarks);

const toVec = (pt) => new THREE.Vector3(
  (pt.x * 2.0 - 1.0) * aspect, -(pt.y * 2.0 - 1.0), -pt.z * aspect * 2.0
);

let wasScissorsClosed = false;
let currentlyPinchingNode = null; 
let isFaceVisible = false;

function onDraw(results) {
  if (results.faceLandmarks) {
    isFaceVisible = true;
    debugFace.innerText = "얼굴 추적: 🟢 정상 인식됨";
    const lms = results.faceLandmarks;
    const ptRight = toVec(lms[454]);
    const ptLeft = toVec(lms[234]);
    const ptTop = toVec(lms[10]);
    const ptBottom = toVec(lms[152]);
    const center = toVec(lms[5]);

    const xAxis = new THREE.Vector3().subVectors(ptLeft, ptRight).normalize();
    const yAxis = new THREE.Vector3().subVectors(ptTop, ptBottom).normalize();
    const zAxis = new THREE.Vector3().crossVectors(xAxis, yAxis).normalize();
    yAxis.crossVectors(zAxis, xAxis).normalize();
    const headRotMatrix = new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis);
    
    globalHeadQuat.setFromRotationMatrix(headRotMatrix);
    globalFaceCenter.copy(center);
    // 머리 중심(회전축)을 코끝이 아니라 실제 머리통 중앙(뒤쪽)으로 조금 밀어줍니다.
    globalFaceCenter.z -= 0.5;

  } else {
    isFaceVisible = false;
    debugFace.innerText = "얼굴 추적: 🔴 인식실패 (화면 밖)";
  }

  let handsData = [];
  if (results.leftHandLandmarks) handsData.push(results.leftHandLandmarks);
  if (results.rightHandLandmarks) handsData.push(results.rightHandLandmarks);

  scissorLine.visible = false; 

  if (handsData.length === 0) {
    debugHand.innerText = "손 추적: 🔴 양손 모두 안보임";
    debugGesture.innerText = "동작: 손이 없습니다.";
  } else {
    debugHand.innerText = `손 추적: 🟢 ${handsData.length}개의 손 모드`;
    let noAction = true;

    handsData.forEach(handData => {
      const extIndex = !isFolded(handData, 8, 5); 
      const extMiddle = !isFolded(handData, 12, 9);
      const foldRing = isFolded(handData, 16, 13);
      const foldPinky = isFolded(handData, 20, 17);

      const isScissorsPose = extIndex && extMiddle && foldRing && foldPinky;
      const scissorDist = getDistance3D(handData[8], handData[12]);
      const isScissorsClosing = isScissorsPose && scissorDist < 0.05;

      // ✂️ 가위질
      if (isScissorsPose) {
         noAction = false;
         const indexPos = toVec(handData[8]);
         const middlePos = toVec(handData[12]);
         
         scissorLine.geometry.setFromPoints([indexPos, middlePos]);
         scissorLine.material.color.setHex(isScissorsClosing ? 0xff0000 : 0x00ff00);
         scissorLine.visible = true;

         debugGesture.innerText = `동작: ✂️ 가위 모드 (간격: ${scissorDist.toFixed(3)})`;

         if (isScissorsClosing) { // 가위를 닫은 채로 움직이면 연속해서 종이를 깎아냅니다!! (드래그 컷팅)
            const paperPos = paperGroup.position;
            if (indexPos.distanceTo(paperPos) < 1.0) {
               
               debugLog.innerText = `🔥 컷팅 시도 중...`;

               const clipPaths = [[]];
               const r = 0.05 * CLIP_SCALE; // 가위의 절단 반경
               for(let i=0; i<16; i++){ // 디버깅: 원을 더 부드럽게 16각
                  const angle = (i/16)*Math.PI*2;
                  // 🚨 ClipperLib는 무조건 정수(Integer) 좌표만 받습니다. Math.round 필수!
                  clipPaths[0].push({
                      X: Math.round((indexPos.x * CLIP_SCALE) + Math.cos(angle)*r),
                      Y: Math.round((indexPos.y * CLIP_SCALE) + Math.sin(angle)*r)
                  });
               }

               const cpr = new ClipperLib.Clipper();
               cpr.AddPaths(mainPaperPaths, ClipperLib.PolyType.ptSubject, true);
               cpr.AddPaths(clipPaths, ClipperLib.PolyType.ptClip, true);

               const solutionTree = new ClipperLib.PolyTree();
               cpr.Execute(ClipperLib.ClipType.ctDifference, solutionTree, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);

               const finalShapes = extractShapes(solutionTree);

               if (finalShapes.length > 0) {
                   debugLog.innerText = `🔥 컷팅 완료! 폴리곤 섬 갯수: ${finalShapes.length}`;
                   // 면적이 가장 큰 것을 메인 도화지로 남긴다
                   finalShapes.sort((a,b) => b.area - a.area);
                   mainPaperPaths = finalShapes[0].paths;
                   
                   const newMainGeo = new THREE.ShapeGeometry(finalShapes[0].shape);
                   if(sourcePaper.geometry) sourcePaper.geometry.dispose();
                   sourcePaper.geometry = newMainGeo;

                   // 그 외의 분리된 파편(islands)들은 전부 떨어져 나온 진짜 종이 조각이 됩니다!
                   for (let i = 1; i < finalShapes.length; i++) {
                       const pieceGeo = new THREE.ShapeGeometry(finalShapes[i].shape);
                       
                       // 무게중심(Center)를 잡아서 쥐었을 때 자연스럽게 만들기
                       pieceGeo.computeBoundingBox();
                       const center = new THREE.Vector3();
                       pieceGeo.boundingBox.getCenter(center);
                       pieceGeo.translate(-center.x, -center.y, -center.z);
                       
                       // 완전 동일한 커스텀 도형 모양 그대로 메쉬 생성!
                       const cutPiece = new THREE.Mesh(pieceGeo, paperMat.clone());
                       cutPiece.material.color.setHSL((Date.now()%3000)/3000, 1.0, 0.5); // 새로운 조각 색상 부여
                       cutPiece.position.set(center.x, center.y, 0); 
                       
                       cutPiece.userData = { isAttached: false, relativePos: null, baseQuat: null };
                       scene.add(cutPiece);
                       cutPieces.push(cutPiece);
                   }
               } else {
                   debugLog.innerText = `❌ 아무것도 안잘림! (종이 밖을 자름)`;
               }
            } 
         }
         wasScissorsClosed = isScissorsClosing;
      }

      // 🤏 집게(Pinch) 모션 인식
      const pinchDist = getDistance3D(handData[4], handData[8]);
      const isPinching = pinchDist < 0.05;
      const pinchVec = toVec(handData[8]); 

      if (!isScissorsPose && isPinching) {
         noAction = false;
         debugGesture.innerText = `동작: 🤏 집게 쥐기 유지 중...`;

         if (currentlyPinchingNode) {
            // [수정점]: 쥐고 있는 동안에는 얼굴에 닿든 말든 손가락만 무조건 따라다닙니다.
            currentlyPinchingNode.position.copy(pinchVec);
            
            // 🌟 엄지와 검지의 2D 방향 각도를 구해서 종이를 '직접' 회전시킵니다!
            const thumbVec = toVec(handData[4]);
            const angle = Math.atan2(pinchVec.y - thumbVec.y, pinchVec.x - thumbVec.x);
            // 자연스러운 각도를 위해 영점 보정!
            currentlyPinchingNode.rotation.z = angle - Math.PI/4;

            // 쥐고 있으니 머리로부터 떨어졌다고 처리 (얼굴 연동 회전 임시 정지됨)
            currentlyPinchingNode.userData.isAttached = false;
         } else {
            for(let i = 0; i < cutPieces.length; i++) {
               let piece = cutPieces[i];
               if (piece.position.distanceTo(pinchVec) < 0.25) { // 집기 판정 반경 넓힘
                  currentlyPinchingNode = piece; 
                  currentlyPinchingNode.userData.isAttached = false; 
                  debugLog.innerText = `🖐️ 종이 잡기 성공!`;
                  break;
               }
            }
         }
      } else if (!isScissorsPose) {
         if (currentlyPinchingNode) {
            if (isFaceVisible && results.faceLandmarks) {
               const headTop = toVec(results.faceLandmarks[10]); 
               const headRight = toVec(results.faceLandmarks[332]); 
               const headLeft = toVec(results.faceLandmarks[103]);

               if (currentlyPinchingNode.position.distanceTo(headTop) < 0.4 || 
                   currentlyPinchingNode.position.distanceTo(headRight) < 0.4 || 
                   currentlyPinchingNode.position.distanceTo(headLeft) < 0.4) {
                  
                  debugLog.innerText = `👑 놓아서 머리핀 장착 성공!`;
                  const invQuat = globalHeadQuat.clone().invert();
                  const localOffset = currentlyPinchingNode.position.clone().sub(globalFaceCenter).applyQuaternion(invQuat);

                  currentlyPinchingNode.userData.isAttached = true;
                  currentlyPinchingNode.userData.relativePos = localOffset;
                  currentlyPinchingNode.userData.baseQuat = currentlyPinchingNode.quaternion.clone().premultiply(invQuat);
               } else {
                  debugLog.innerText = `🍃 허공에 찰싹 멈춤.`;
               }
            } else {
               debugLog.innerText = `🍃 허공에 찰싹 멈춤.`;
            }
            currentlyPinchingNode = null; 
         }
      }

      if(noAction) {
         debugGesture.innerText = `동작: ✋ 대기중 (손을 펴거나 쥔 상태)`;
         wasScissorsClosed = false;
      }
    });
  }
}

function animate() {
  requestAnimationFrame(animate);

  cutPieces.forEach(piece => {
     if (piece.userData.isAttached && isFaceVisible) {
        piece.position.copy(piece.userData.relativePos)
                      .applyQuaternion(globalHeadQuat)
                      .add(globalFaceCenter);
        piece.quaternion.copy(globalHeadQuat).multiply(piece.userData.baseQuat);
     } 
  });

  renderer.render(scene, camera);
}
animate();

initHolisticTracking(videoElement, {
  loadingText: document.getElementById('loadingText'),
  width: 1280,
  height: 720
}, onDraw);
