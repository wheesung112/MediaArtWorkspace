# Interactive Media Art Workspace 🎨

Google MediaPipe(Hand/Face Tracking) 및 Three.js(WebGL) 기반 미디어아트 프로젝트 모음 저장소입니다. 브라우저에서 실시간 컴포넌트 렌더링 및 모션 트래킹을 수행합니다.

## ✨ Projects Included

1. **`01_FingerGun`**: 손가락 쌍권총 이펙트 (Hand Tracking)
2. **`02_WeldingArt`**: 검지 궤적으로 불꽃 용접 및 빛 번짐 효과 (Hand Tracking + Shader Bloom)
3. **`03_PostItShake`**: 3D 매트릭스 얼굴 추적 스티커 & 헤드뱅잉 게임 (Face Mesh)
4. **`04_HairpinCut`**: 무지개 색종이를 직접 가위로 잘라서 얼굴에 부착 (Holistic - Face+Hands, CSG Mesh Slicing)

## 🚀 How to Run (Mac / Windows 공통)

이 프로젝트는 클라이언트 사이드 바닐라 웹 기술로 제작되어 빌드가 필요 없습니다. `index.html`만 로컬 서버로 구동하면 바로 동작합니다.

1. 이 저장소를 로컬로 `clone` 합니다.
2. VS Code에서 **MediaArtWorkspace** 폴더를 엽니다.
3. 원하는 프로젝트 폴더 안의 `index.html` 파일을 엽니다.
4. VS Code 확장 프로그램인 [Live Server](https://marketplace.visualstudio.com/items?itemName=ritwickdey.LiveServer)를 설치한 뒤, 우측 하단의 **"Go Live"** 버튼을 클릭합니다.
5. 브라우저가 열리면 반드시 **[카메라(웹캠) 권한 허용]**을 눌러주세요. (최적 성능을 위해 Safari보단 **Chrome** 권장)

## 🛠 Tech Stack
- HTML5 / CSS3 / Vanilla Javascript (ES6 Modules)
- Three.js (3D Rendering)
- MediaPipe Hands / FaceMesh / Holistic (AI Tracking via CDN)
- ClipperLib (Polygon clipping)
