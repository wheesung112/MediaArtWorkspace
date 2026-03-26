import * as THREE from 'three/webgpu';
import { Fn, If, Return, instancedArray, instanceIndex, uniform, attribute, uint, float, clamp, struct, atomicStore, int, ivec3, array, vec3, atomicAdd, Loop, atomicLoad, max, pow, mat3, vec4, cross, step, storage } from 'three/tsl';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import WebGPU from 'three/addons/capabilities/WebGPU.js';

let renderer, scene, camera, controls;

const maxParticles = 8192 * 12; // ?뚰떚???섎? 9留?泥쒓컻濡?利앷??쒖폒 諛吏묐룄瑜??믪엫
const gridSize1d = 64;
const workgroupSize = 64;
const gridSize = new THREE.Vector3(gridSize1d, gridSize1d, gridSize1d);
const fixedPointMultiplier = 1e7;

let particleCountUniform, stiffnessUniform, restDensityUniform, dynamicViscosityUniform, dtUniform, gravityUniform, gridSizeUniform;
let particleBuffer, cellBuffer, cellBufferFloat;
let clearGridKernel, p2g1Kernel, p2g2Kernel, updateGridKernel, g2pKernel, workgroupKernel;
let p2g1KernelWorkgroupBuffer, p2g2KernelWorkgroupBuffer, g2pKernelWorkgroupBuffer;
let particleMesh;
let pinchIndicatorGroup;
let pinchIndicatorMeshes = [];
let currentIndicatorCount = 0;
const currentIndicatorAnchorWorld = new THREE.Vector3();
let hasIndicatorAnchor = false;
let dioramaTextMesh;
let indicatorTextMesh;
let frameRefs = null;

// ?ㅼ씠?ㅻ씪留?洹몃９ 諛??몃뱶?몃옒???뚯쟾媛?蹂??
let dioramaGroup;
let poolBorder;
let poolBottom;
let targetRotX = 0;
let targetRotZ = 0;
let targetParticleCount = maxParticles;
// 臾쇰━諛뺤뒪 寃쎄퀎媛?(gridSize 湲곗?)
const BOUNDS = 4.4;
const MIN_PARTICLES = 8192 * 2;
const MAX_PARTICLES = maxParticles;
const ROTATION_RANGE_MULTIPLIER = 1.2;
const DIORAMA_FLOAT_OFFSET_Y = 1.0;
const DIORAMA_FOLLOW_LERP = 0.18;
const DIORAMA_SCALE_NEAR = 0.97;
const DIORAMA_SCALE_FAR = 0.43;
const LEFT_HAND_NEAR_Z = -0.18;
const LEFT_HAND_FAR_Z = 0.12;
const DIORAMA_SCALE_LERP = 0.22;
const RIGHT_PINCH_MIN_DIST = 0.025;
const RIGHT_PINCH_MAX_DIST = 0.25;
const PINCH_UPDATE_DISTANCE_DELTA = 0.018;
const EMIT_RAMP_SPEED = 0.1;
const PINCH_INDICATOR_MIN_COUNT = 1;
const PINCH_INDICATOR_MAX_COUNT = 7;
const PINCH_INDICATOR_RADIUS = 0.14;
const PINCH_INDICATOR_DEPTH = 14.0;
const DIORAMA_TEXT_WIDTH = 7.6;
const DIORAMA_TEXT_HEIGHT = 2.4;
const INDICATOR_TEXT_WIDTH = 4.0;
const INDICATOR_TEXT_HEIGHT = 0.9;

const targetDioramaPosition = new THREE.Vector3(0, 0, 0);
let isBoxActive = false;
let wasRightHandPresent = false;
let emissionEnabled = false;
let lastAppliedRightPinchDistance = null;
let targetDioramaScale = 0.67;

if (WebGPU.isAvailable() === false) {
	document.body.appendChild(WebGPU.getErrorMessage());
	throw new Error('No WebGPU support');
}

const params = {
	particleCount: 0,
};

init();

async function init() {
	renderer = new THREE.WebGPURenderer({ antialias: true, alpha: true, requiredLimits: { maxStorageBuffersInVertexStage: 1 } });
	renderer.setPixelRatio(window.devicePixelRatio);
	renderer.setSize(window.innerWidth, window.innerHeight);
	renderer.toneMapping = THREE.ACESFilmicToneMapping;
	renderer.toneMappingExposure = 1.35;
	renderer.setClearColor(0x000000, 0); // ?꾩쟾 ?щ챸 ?⑹꽦

	const container = document.createElement('div');
	container.style.position = 'absolute';
	container.style.top = '0';
	container.style.left = '0';
	container.style.zIndex = '10';
	document.body.appendChild(container);
	container.appendChild(renderer.domElement);

	scene = new THREE.Scene();
	camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.01, 100);
	camera.position.set(0, 0, 15);
	camera.lookAt(0, 0, 0);

	controls = new OrbitControls(camera, renderer.domElement);
	controls.enableDamping = true;
	controls.enabled = false;

	// 議곕챸 ?명똿 (?섍꼍留??앸왂)
	const ambientLight = new THREE.AmbientLight(0xffffff, 1.5);
	scene.add(ambientLight);
	const sun = new THREE.DirectionalLight(0xffffff, 2.5);
	sun.position.set(-5, 10, 5);
	scene.add(sun);

	// ?ㅼ씠?ㅻ씪留?洹몃９ 珥덇린??
	dioramaGroup = new THREE.Group();
	dioramaGroup.scale.setScalar(targetDioramaScale);
	scene.add(dioramaGroup);

	// ?섏“ ?좊━ 硫붿돩
	const borderGeom = new THREE.BoxGeometry(BOUNDS, BOUNDS, BOUNDS);
	const borderEdgesGeom = new THREE.EdgesGeometry(borderGeom);
	const borderMat = new THREE.LineBasicMaterial({
		color: 0xffffff,
		transparent: true,
		opacity: 0.24,
		depthTest: false,
		depthWrite: false,
		toneMapped: false
	});
	poolBorder = new THREE.LineSegments(borderEdgesGeom, borderMat);
	poolBorder.position.y = 0.0;
	poolBorder.renderOrder = 9999;
	poolBorder.frustumCulled = false;
	poolBorder.visible = false;
	dioramaGroup.add(poolBorder);

	setupParticles();
	initTelemetryHud();
	initSceneLabels();

	const numWorkgroups = Math.ceil(params.particleCount / workgroupSize);
	p2g1KernelWorkgroupBuffer = new THREE.IndirectStorageBufferAttribute(new Uint32Array([numWorkgroups, 1, 1]), 1);
	p2g2KernelWorkgroupBuffer = new THREE.IndirectStorageBufferAttribute(new Uint32Array([numWorkgroups, 1, 1]), 1);
	g2pKernelWorkgroupBuffer = new THREE.IndirectStorageBufferAttribute(new Uint32Array([numWorkgroups, 1, 1]), 1);

	const p2g1WorkgroupStorage = storage(p2g1KernelWorkgroupBuffer, 'uint', 3);
	const p2g2WorkgroupStorage = storage(p2g2KernelWorkgroupBuffer, 'uint', 3);
	const g2pWorkgroupStorage = storage(g2pKernelWorkgroupBuffer, 'uint', 3);

	workgroupKernel = Fn(() => {
		const workgroupsToDispatch = (particleCountUniform.sub(1)).div(workgroupSize).add(1);
		p2g1WorkgroupStorage.element(0).assign(workgroupsToDispatch);
		p2g2WorkgroupStorage.element(0).assign(workgroupsToDispatch);
		g2pWorkgroupStorage.element(0).assign(workgroupsToDispatch);
	})().compute(1);

	window.addEventListener('resize', onWindowResize);
	initHandTracking();

	// Set animation loop
	let lastTime = performance.now();
	renderer.setAnimationLoop(() => {
		const now = performance.now();
		const delta = Math.min((now - lastTime) / 1000, 1 / 30);
		lastTime = now;
		render(delta);
	});
}

function setupBuffers() {
	const particleStruct = struct({
		position: { type: 'vec3' },
		velocity: { type: 'vec3' },
		C: { type: 'mat3' },
	});
	const particleStructSize = 20;
	const particleArray = new Float32Array(maxParticles * particleStructSize);

	for (let i = 0; i < maxParticles; i++) {
		// Spawn near the top-center so particles appear to pour down when activated.
		particleArray[i * particleStructSize] = (Math.random() * 0.12 + 0.44);
		particleArray[i * particleStructSize + 1] = (Math.random() * 0.16 + 0.80);
		particleArray[i * particleStructSize + 2] = (Math.random() * 0.12 + 0.44);
	}

	particleBuffer = instancedArray(particleArray, particleStruct);

	const cellCount = gridSize.x * gridSize.y * gridSize.z;
	const cellStruct = struct({
		x: { type: 'int', atomic: true },
		y: { type: 'int', atomic: true },
		z: { type: 'int', atomic: true },
		mass: { type: 'int', atomic: true },
	});

	cellBuffer = instancedArray(cellCount, cellStruct);
	cellBufferFloat = instancedArray(cellCount, 'vec4');
}

function setupUniforms() {
	gridSizeUniform = uniform(gridSize);
	particleCountUniform = uniform(params.particleCount, 'uint');
	stiffnessUniform = uniform(50);
	restDensityUniform = uniform(1.5);
	dynamicViscosityUniform = uniform(0.1);
	dtUniform = uniform(1 / 60);

	// ??Base 以묐젰??濡쒖뺄 ?곴났?먯꽌 ?꾨옒瑜??ν븯寃?留뚮벊?덈떎. ?섏쨷???뚯쟾?됰젹???섑빐 ??쑝濡??뚯븘媛묐땲??
	gravityUniform = uniform(new THREE.Vector3(0, - (9.81 * 9.81), 0));
}

function setupComputeShaders() {
	const encodeFixedPoint = (f32) => {
		return int(f32.mul(fixedPointMultiplier));
	};
	const decodeFixedPoint = (i32) => {
		return float(i32).div(fixedPointMultiplier);
	};

	const cellCount = gridSize.x * gridSize.y * gridSize.z;
	clearGridKernel = Fn(() => {
		If(instanceIndex.greaterThanEqual(uint(cellCount)), () => { Return(); });
		atomicStore(cellBuffer.element(instanceIndex).get('x'), 0);
		atomicStore(cellBuffer.element(instanceIndex).get('y'), 0);
		atomicStore(cellBuffer.element(instanceIndex).get('z'), 0);
		atomicStore(cellBuffer.element(instanceIndex).get('mass'), 0);
	})().compute(cellCount).setName('clearGridKernel');

	p2g1Kernel = Fn(() => {
		If(instanceIndex.greaterThanEqual(particleCountUniform), () => { Return(); });
		const particlePosition = particleBuffer.element(instanceIndex).get('position').toConst('particlePosition');
		const particleVelocity = particleBuffer.element(instanceIndex).get('velocity').toConst('particleVelocity');
		const C = particleBuffer.element(instanceIndex).get('C').toConst('C');

		const gridPosition = particlePosition.mul(gridSizeUniform).toVar();
		const cellIndex = ivec3(gridPosition).sub(1).toConst('cellIndex');
		const cellDiff = gridPosition.fract().sub(0.5).toConst('cellDiff');
		const w0 = float(0.5).mul(float(0.5).sub(cellDiff)).mul(float(0.5).sub(cellDiff));
		const w1 = float(0.75).sub(cellDiff.mul(cellDiff));
		const w2 = float(0.5).mul(float(0.5).add(cellDiff)).mul(float(0.5).add(cellDiff));
		const weights = array([w0, w1, w2]).toConst('weights');

		Loop({ start: 0, end: 3, type: 'int', name: 'gx', condition: '<' }, ({ gx }) => {
			Loop({ start: 0, end: 3, type: 'int', name: 'gy', condition: '<' }, ({ gy }) => {
				Loop({ start: 0, end: 3, type: 'int', name: 'gz', condition: '<' }, ({ gz }) => {
					const weight = weights.element(gx).x.mul(weights.element(gy).y).mul(weights.element(gz).z);
					const cellX = cellIndex.add(ivec3(gx, gy, gz)).toConst();
					const cellDist = vec3(cellX).add(0.5).sub(gridPosition).toConst('cellDist');
					const Q = C.mul(cellDist);

					const massContrib = weight;
					const velContrib = massContrib.mul(particleVelocity.add(Q)).toConst('velContrib');
					const cellPtr = cellX.x.mul(int(gridSize.y * gridSize.z)).add(cellX.y.mul(int(gridSize.z))).add(cellX.z).toConst();
					const cell = cellBuffer.element(cellPtr);

					atomicAdd(cell.get('x'), encodeFixedPoint(velContrib.x));
					atomicAdd(cell.get('y'), encodeFixedPoint(velContrib.y));
					atomicAdd(cell.get('z'), encodeFixedPoint(velContrib.z));
					atomicAdd(cell.get('mass'), encodeFixedPoint(massContrib));
				});
			});
		});
	})().compute(params.particleCount, [workgroupSize, 1, 1]).setName('p2g1Kernel');

	p2g2Kernel = Fn(() => {
		If(instanceIndex.greaterThanEqual(particleCountUniform), () => { Return(); });
		const particlePosition = particleBuffer.element(instanceIndex).get('position').toConst('particlePosition');
		const gridPosition = particlePosition.mul(gridSizeUniform).toVar();

		const cellIndex = ivec3(gridPosition).sub(1).toConst('cellIndex');
		const cellDiff = gridPosition.fract().sub(0.5).toConst('cellDiff');
		const w0 = float(0.5).mul(float(0.5).sub(cellDiff)).mul(float(0.5).sub(cellDiff));
		const w1 = float(0.75).sub(cellDiff.mul(cellDiff));
		const w2 = float(0.5).mul(float(0.5).add(cellDiff)).mul(float(0.5).add(cellDiff));
		const weights = array([w0, w1, w2]).toConst('weights');

		const density = float(0).toVar('density');
		Loop({ start: 0, end: 3, type: 'int', name: 'gx', condition: '<' }, ({ gx }) => {
			Loop({ start: 0, end: 3, type: 'int', name: 'gy', condition: '<' }, ({ gy }) => {
				Loop({ start: 0, end: 3, type: 'int', name: 'gz', condition: '<' }, ({ gz }) => {
					const weight = weights.element(gx).x.mul(weights.element(gy).y).mul(weights.element(gz).z);
					const cellX = cellIndex.add(ivec3(gx, gy, gz)).toConst();
					const cellPtr = cellX.x.mul(int(gridSize.y * gridSize.z)).add(cellX.y.mul(int(gridSize.z))).add(cellX.z).toConst();
					const cell = cellBuffer.element(cellPtr);
					const mass = decodeFixedPoint(atomicLoad(cell.get('mass')));
					density.addAssign(mass.mul(weight));
				});
			});
		});

		const volume = float(1).div(density);
		const pressure = max(0.0, pow(density.div(restDensityUniform), 5.0).sub(1).mul(stiffnessUniform)).toConst('pressure');
		const stress = mat3(pressure.negate(), 0, 0, 0, pressure.negate(), 0, 0, 0, pressure.negate()).toVar('stress');
		const dudv = particleBuffer.element(instanceIndex).get('C').toConst('C');

		const strain = dudv.add(dudv.transpose());
		stress.addAssign(strain.mul(dynamicViscosityUniform));
		const eq16Term0 = volume.mul(- 4).mul(stress).mul(dtUniform);

		Loop({ start: 0, end: 3, type: 'int', name: 'gx', condition: '<' }, ({ gx }) => {
			Loop({ start: 0, end: 3, type: 'int', name: 'gy', condition: '<' }, ({ gy }) => {
				Loop({ start: 0, end: 3, type: 'int', name: 'gz', condition: '<' }, ({ gz }) => {
					const weight = weights.element(gx).x.mul(weights.element(gy).y).mul(weights.element(gz).z);
					const cellX = cellIndex.add(ivec3(gx, gy, gz)).toConst();
					const cellDist = vec3(cellX).add(0.5).sub(gridPosition).toConst('cellDist');
					const momentum = eq16Term0.mul(weight).mul(cellDist).toConst('momentum');

					const cellPtr = cellX.x.mul(int(gridSize.y * gridSize.z)).add(cellX.y.mul(int(gridSize.z))).add(cellX.z).toConst();
					const cell = cellBuffer.element(cellPtr);
					atomicAdd(cell.get('x'), encodeFixedPoint(momentum.x));
					atomicAdd(cell.get('y'), encodeFixedPoint(momentum.y));
					atomicAdd(cell.get('z'), encodeFixedPoint(momentum.z));
				});
			});
		});
	})().compute(params.particleCount, [workgroupSize, 1, 1]).setName('p2g2Kernel');

	updateGridKernel = Fn(() => {
		If(instanceIndex.greaterThanEqual(uint(cellCount)), () => { Return(); });
		const cell = cellBuffer.element(instanceIndex);
		const mass = decodeFixedPoint(atomicLoad(cell.get('mass'))).toConst();
		If(mass.lessThanEqual(0), () => { Return(); });

		const vx = decodeFixedPoint(atomicLoad(cell.get('x'))).div(mass).toVar();
		const vy = decodeFixedPoint(atomicLoad(cell.get('y'))).div(mass).toVar();
		const vz = decodeFixedPoint(atomicLoad(cell.get('z'))).div(mass).toVar();

		const x = int(instanceIndex).div(int(gridSize.z * gridSize.y));
		const y = int(instanceIndex).div(int(gridSize.z)).mod(int(gridSize.y));
		const z = int(instanceIndex).mod(int(gridSize.z));

		// 寃쎄퀎?좎뿉 遺?ろ엳硫??띾룄瑜?0?쇰줈 (?섏“ ?대???媛뉙엳寃?
		If(x.lessThan(int(1)).or(x.greaterThan(int(gridSize.x).sub(int(2)))), () => { vx.assign(0); });
		If(y.lessThan(int(1)).or(y.greaterThan(int(gridSize.y).sub(int(2)))), () => { vy.assign(0); });
		If(z.lessThan(int(1)).or(z.greaterThan(int(gridSize.z).sub(int(2)))), () => { vz.assign(0); });

		cellBufferFloat.element(instanceIndex).assign(vec4(vx, vy, vz, mass));
	})().compute(cellCount).setName('updateGridKernel');

	g2pKernel = Fn(() => {
		If(instanceIndex.greaterThanEqual(particleCountUniform), () => { Return(); });
		const particlePosition = particleBuffer.element(instanceIndex).get('position').toVar('particlePosition');
		const gridPosition = particlePosition.mul(gridSizeUniform).toVar();
		const particleVelocity = vec3(0).toVar();

		const cellIndex = ivec3(gridPosition).sub(1).toConst('cellIndex');
		const cellDiff = gridPosition.fract().sub(0.5).toConst('cellDiff');

		const w0 = float(0.5).mul(float(0.5).sub(cellDiff)).mul(float(0.5).sub(cellDiff));
		const w1 = float(0.75).sub(cellDiff.mul(cellDiff));
		const w2 = float(0.5).mul(float(0.5).add(cellDiff)).mul(float(0.5).add(cellDiff));
		const weights = array([w0, w1, w2]).toConst('weights');

		const B = mat3(0).toVar('B');
		Loop({ start: 0, end: 3, type: 'int', name: 'gx', condition: '<' }, ({ gx }) => {
			Loop({ start: 0, end: 3, type: 'int', name: 'gy', condition: '<' }, ({ gy }) => {
				Loop({ start: 0, end: 3, type: 'int', name: 'gz', condition: '<' }, ({ gz }) => {
					const weight = weights.element(gx).x.mul(weights.element(gy).y).mul(weights.element(gz).z);
					const cellX = cellIndex.add(ivec3(gx, gy, gz)).toConst();
					const cellDist = vec3(cellX).add(0.5).sub(gridPosition).toConst('cellDist');
					const cellPtr = cellX.x.mul(int(gridSize.y * gridSize.z)).add(cellX.y.mul(int(gridSize.z))).add(cellX.z).toConst();

					const weightedVelocity = cellBufferFloat.element(cellPtr).xyz.mul(weight).toConst('weightedVelocity');
					const term = mat3(
						weightedVelocity.mul(cellDist.x),
						weightedVelocity.mul(cellDist.y),
						weightedVelocity.mul(cellDist.z)
					);
					B.addAssign(term);
					particleVelocity.addAssign(weightedVelocity);
				});
			});
		});

		particleBuffer.element(instanceIndex).get('C').assign(B.mul(4));

		// **Gravity Pull**
		particleVelocity.addAssign(gravityUniform.mul(dtUniform));
		// Add mild damping and a small downward bias to prevent long-lived floating particles.
		particleVelocity.mulAssign(0.992);
		particleVelocity.addAssign(vec3(0, -2.0, 0).mul(dtUniform));

		// scale from (gridSize.x, gridSize.y, gridSize.z) to (1, 1, 1)
		particleVelocity.divAssign(gridSizeUniform);

		// add velocity to position
		particlePosition.addAssign(particleVelocity.mul(dtUniform));

		// clamp position so outermost gridCells are not reached
		// ?닿쾬???섏“??踰???븷???섑뻾?⑸땲??
		particlePosition.assign(clamp(particlePosition, vec3(1).div(gridSizeUniform), vec3(gridSize).sub(1).div(gridSizeUniform)));

		// scale from (1, 1, 1) back to (gridSize.x, gridSize.y, gridSize.z) to
		particleVelocity.mulAssign(gridSizeUniform);

		particleBuffer.element(instanceIndex).get('position').assign(particlePosition);
		particleBuffer.element(instanceIndex).get('velocity').assign(particleVelocity);
	})().compute(params.particleCount, [workgroupSize, 1, 1]).setName('g2pKernel');
}

function setupMesh() {
	// Restore glossy faceted water look.
	const geometry = BufferGeometryUtils.mergeVertices(new THREE.IcosahedronGeometry(0.12, 1).deleteAttribute('uv'));

	// 臾쇰━ 湲곕컲 援댁젅/?щ챸 ?ъ쭏???ъ슜?섏뿬 臾쇰갑???⑹뼱由ъ쿂??蹂댁씠寃??뚮뜑留?
	const material = new THREE.MeshPhysicalNodeMaterial({
		color: '#66ccff',
		roughness: 0.0,
		metalness: 0.03,
		transmission: 0.95,
		ior: 1.33,              // 臾쇱쓽 援댁젅瑜?
		thickness: 1.5,
		clearcoat: 1.0,
		clearcoatRoughness: 0.0
	});
	material.transparent = true;
	material.wireframe = false;

	// ?뚰떚??醫뚰몴怨꾨? (0 ~ 1)?먯꽌 諛뺤뒪 ?ш린(媛濡쒖꽭濡?BOUNDS, ?믪씠 2.0)濡?蹂??
	material.positionNode = Fn(() => {
		const particlePosition = particleBuffer.element(instanceIndex).get('position');
		// Map simulation [0..1] coordinates to a cube in world space.
		const mappedPos = particlePosition.sub(0.5).mul(vec3(BOUNDS, BOUNDS, BOUNDS));
		return attribute('position').add(mappedPos);
	})();

	particleMesh = new THREE.Mesh(geometry, material);
	particleMesh.count = params.particleCount;
	particleMesh.frustumCulled = false;
	// 臾쇨껐 諛뺤뒪???쇳꽣 ?믪씠(1.0)??留욎떠???щ젮二쇰㈃ [0.0 ~ 2.0] 援ш컙?먯꽌 異쒕쟻嫄곕┰?덈떎.
	particleMesh.position.set(0, 0.0, 0);

	// ???뚰떚??硫붿돩?ㅼ쓣 ?ㅼ씠?ㅻ씪留?洹몃９??臾띠뒿?덈떎!
	dioramaGroup.add(particleMesh);
}

function setupParticles() {
	setupBuffers();
	setupUniforms();
	setupComputeShaders();
	setupMesh();
}

function onWindowResize() {
	camera.aspect = window.innerWidth / window.innerHeight;
	camera.updateProjectionMatrix();
	renderer.setSize(window.innerWidth, window.innerHeight);
}

function getDistance3D(p1, p2) {
	const dx = p1.x - p2.x;
	const dy = p1.y - p2.y;
	const dz = p1.z - p2.z;
	return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function isFingerFolded(landmarks, tipIdx, mcpIdx) {
	const palmSize = getDistance3D(landmarks[0], landmarks[9]);
	const fingerLength = getDistance3D(landmarks[tipIdx], landmarks[mcpIdx]);
	return fingerLength < palmSize * 0.7;
}

function isLeftIndexUpPose(landmarks) {
	const indexExtended = !isFingerFolded(landmarks, 8, 5);
	const middleFolded = isFingerFolded(landmarks, 12, 9);
	const ringFolded = isFingerFolded(landmarks, 16, 13);
	const pinkyFolded = isFingerFolded(landmarks, 20, 17);
	return indexExtended && middleFolded && ringFolded && pinkyFolded;
}

function landmarkToDioramaTarget(landmark) {
	// Place cube center half-size above fingertip so cube bottom touches fingertip.
	return handLandmarkToOverlayWorld(landmark, PINCH_INDICATOR_DEPTH).add(new THREE.Vector3(0, BOUNDS * 0.5, 0));
}

function mapLeftDepthToScale(landmarkZ) {
	const t = THREE.MathUtils.clamp((landmarkZ - LEFT_HAND_NEAR_Z) / (LEFT_HAND_FAR_Z - LEFT_HAND_NEAR_Z), 0, 1);
	return THREE.MathUtils.lerp(DIORAMA_SCALE_NEAR, DIORAMA_SCALE_FAR, t);
}

function mapRightPinchToParticleCount(pinchDistance) {
	const normalized = THREE.MathUtils.clamp((pinchDistance - RIGHT_PINCH_MIN_DIST) / (RIGHT_PINCH_MAX_DIST - RIGHT_PINCH_MIN_DIST), 0, 1);
	return Math.round(THREE.MathUtils.lerp(MIN_PARTICLES, MAX_PARTICLES, normalized));
}

function initTelemetryHud() {
	frameRefs = {
		particles: document.getElementById('frameParticles'),
		state: document.getElementById('frameState')
	};
}

function createTextPlane(width, height, canvasWidth, canvasHeight) {
	const canvas = document.createElement('canvas');
	canvas.width = canvasWidth;
	canvas.height = canvasHeight;
	const texture = new THREE.CanvasTexture(canvas);
	texture.needsUpdate = true;

	const material = new THREE.MeshBasicMaterial({
		map: texture,
		transparent: true,
		depthTest: false,
		depthWrite: false,
		toneMapped: false
	});

	const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material);
	mesh.renderOrder = 10001;
	mesh.frustumCulled = false;
	mesh.userData = { canvas, ctx: canvas.getContext('2d'), texture };
	return mesh;
}

function drawTextPlane(mesh, lines, options = {}) {
	const ctx = mesh.userData.ctx;
	const canvas = mesh.userData.canvas;
	ctx.clearRect(0, 0, canvas.width, canvas.height);

	ctx.strokeStyle = 'rgba(255,255,255,0.42)';
	ctx.fillStyle = 'rgba(255,255,255,0.94)';
	ctx.lineWidth = 1.25;
	ctx.font = `${options.titleSize || 34}px Helvetica Neue, Arial, sans-serif`;
	ctx.textBaseline = 'top';
	ctx.textAlign = options.align || 'left';

	let y = 18;
	const textX = options.align === 'center' ? canvas.width * 0.5 : 18;
	if (options.title) {
		ctx.fillText(options.title, textX, y);
		y += 40;
	}

	ctx.font = `${options.bodySize || 24}px Consolas, Menlo, monospace`;
	for (const line of lines) {
		ctx.fillText(line, textX, y);
		y += options.lineGap || 30;
	}

	mesh.userData.texture.needsUpdate = true;
}

function initSceneLabels() {
	dioramaTextMesh = createTextPlane(DIORAMA_TEXT_WIDTH, DIORAMA_TEXT_HEIGHT, 2048, 640);
	// Align text block's left edge with cube's left edge on the front face.
	const leftAlignedX = (-BOUNDS * 0.5) + (DIORAMA_TEXT_WIDTH * 0.5);
	dioramaTextMesh.position.set(leftAlignedX, BOUNDS * 0.46, BOUNDS * 0.56);
	dioramaGroup.add(dioramaTextMesh);

	indicatorTextMesh = createTextPlane(INDICATOR_TEXT_WIDTH, INDICATOR_TEXT_HEIGHT, 1400, 260);
	indicatorTextMesh.visible = false;
	scene.add(indicatorTextMesh);
}

function formatVec3(vec, digits = 2) {
	return `(${vec.x.toFixed(digits)}, ${vec.y.toFixed(digits)}, ${vec.z.toFixed(digits)})`;
}

function updateTelemetryHud() {
	if (!frameRefs) return;

	const rotDeg = new THREE.Vector3(
		THREE.MathUtils.radToDeg(dioramaGroup.rotation.x),
		THREE.MathUtils.radToDeg(dioramaGroup.rotation.y),
		THREE.MathUtils.radToDeg(dioramaGroup.rotation.z)
	);
	frameRefs.particles.textContent = params.particleCount.toLocaleString();
	frameRefs.state.textContent = isBoxActive ? (emissionEnabled ? 'Active' : 'Ready') : 'Idle';

	if (dioramaTextMesh) {
		dioramaTextMesh.visible = isBoxActive;
		drawTextPlane(dioramaTextMesh, [
			`P: ${params.particleCount.toLocaleString()}`,
			`POS: ${formatVec3(dioramaGroup.position, 2)}`,
			`ROT: ${formatVec3(rotDeg, 1)}`,
			`S: ${dioramaGroup.scale.x.toFixed(2)}`
		], { bodySize: 46, lineGap: 54 });
	}

	if (indicatorTextMesh) {
		indicatorTextMesh.visible = hasIndicatorAnchor;
		if (hasIndicatorAnchor) {
			drawTextPlane(indicatorTextMesh, [`INDICATOR: ${currentIndicatorCount}`], { bodySize: 56, lineGap: 56, align: 'center' });
		}
	}
}

function handLandmarkToOverlayWorld(landmark, depth = PINCH_INDICATOR_DEPTH) {
	const ndcX = (landmark.x * 2.0) - 1.0;
	const ndcY = -((landmark.y * 2.0) - 1.0);
	const ndcPos = new THREE.Vector3(ndcX, ndcY, 0.0).unproject(camera);
	const rayDir = ndcPos.sub(camera.position).normalize();
	return camera.position.clone().add(rayDir.multiplyScalar(depth));
}

function getCoverTransform(srcW, srcH, dstW, dstH) {
	const scale = Math.max(dstW / srcW, dstH / srcH);
	const drawW = srcW * scale;
	const drawH = srcH * scale;
	const drawX = (dstW - drawW) * 0.5;
	const drawY = (dstH - drawH) * 0.5;
	return { srcW, srcH, dstW, dstH, scale, drawW, drawH, drawX, drawY };
}

function remapLandmarkToCover(landmark, t) {
	const px = landmark.x * t.srcW;
	const py = landmark.y * t.srcH;
	const mappedX = (px * t.scale + t.drawX) / t.dstW;
	const mappedY = (py * t.scale + t.drawY) / t.dstH;
	return { ...landmark, x: 1 - mappedX, y: mappedY };
}

function remapLandmarksToCover(landmarks, t) {
	return landmarks.map((lm) => remapLandmarkToCover(lm, t));
}

function ensurePinchIndicatorPool() {
	if (pinchIndicatorGroup) return;

	pinchIndicatorGroup = new THREE.Group();
	pinchIndicatorGroup.renderOrder = 10000;
	scene.add(pinchIndicatorGroup);

	const indicatorGeometry = new THREE.SphereGeometry(PINCH_INDICATOR_RADIUS, 10, 10);
	const indicatorMaterial = new THREE.MeshPhysicalMaterial({
		color: '#66ccff',
		roughness: 0.0,
		metalness: 0.03,
		transmission: 0.95,
		ior: 1.33,
		thickness: 1.5,
		clearcoat: 1.0,
		clearcoatRoughness: 0.0,
		transparent: true,
		depthTest: false,
		depthWrite: false,
		toneMapped: false
	});

	for (let i = 0; i < PINCH_INDICATOR_MAX_COUNT; i++) {
		const dot = new THREE.Mesh(indicatorGeometry, indicatorMaterial);
		dot.visible = false;
		dot.renderOrder = 10000;
		dot.frustumCulled = false;
		pinchIndicatorGroup.add(dot);
		pinchIndicatorMeshes.push(dot);
	}
}

function updatePinchIndicatorVisual(thumbLandmark, indexLandmark, pinchDistance, shouldShow) {
	if (!pinchIndicatorGroup) ensurePinchIndicatorPool();
	if (!shouldShow || !thumbLandmark || !indexLandmark) {
		for (const dot of pinchIndicatorMeshes) dot.visible = false;
		currentIndicatorCount = 0;
		hasIndicatorAnchor = false;
		return;
	}

	const normalizedAmount = THREE.MathUtils.clamp((pinchDistance - RIGHT_PINCH_MIN_DIST) / (RIGHT_PINCH_MAX_DIST - RIGHT_PINCH_MIN_DIST), 0, 1);
	const indicatorCount = Math.round(THREE.MathUtils.lerp(PINCH_INDICATOR_MIN_COUNT, PINCH_INDICATOR_MAX_COUNT, normalizedAmount));
	currentIndicatorCount = indicatorCount;
	const thumbWorld = handLandmarkToOverlayWorld(thumbLandmark);
	const indexWorld = handLandmarkToOverlayWorld(indexLandmark);
	currentIndicatorAnchorWorld.copy(thumbWorld).lerp(indexWorld, 0.5);
	hasIndicatorAnchor = true;

	if (indicatorTextMesh) {
		const handDir = indexWorld.clone().sub(thumbWorld).normalize();
		const normal = new THREE.Vector3(-handDir.y, handDir.x, 0);
		// Place text on the opposite side of the indicator line, closer to the dots.
		indicatorTextMesh.position.copy(currentIndicatorAnchorWorld).add(normal.multiplyScalar(-0.14));
		// Flip 180 deg while keeping it parallel to the indicator line.
		indicatorTextMesh.rotation.set(0, 0, Math.atan2(handDir.y, handDir.x) + Math.PI);
	}

	for (let i = 0; i < pinchIndicatorMeshes.length; i++) {
		const dot = pinchIndicatorMeshes[i];
		if (i < indicatorCount) {
			const t = (i + 1) / (indicatorCount + 1); // equal spacing
			dot.position.lerpVectors(thumbWorld, indexWorld, t);
			dot.visible = true;
		} else {
			dot.visible = false;
		}
	}
}

function initHandTracking() {
	const videoElement = document.querySelector('.input_video');
	const canvasElement = document.querySelector('.output_canvas');
	const canvasCtx = canvasElement.getContext('2d');

	canvasElement.width = window.innerWidth;
	canvasElement.height = window.innerHeight;

	window.addEventListener('resize', () => {
		canvasElement.width = window.innerWidth;
		canvasElement.height = window.innerHeight;
	});

	const hands = new window.Hands({
		locateFile: (file) => 'https://cdn.jsdelivr.net/npm/@mediapipe/hands/' + file
	});

	hands.setOptions({
		maxNumHands: 2,
		modelComplexity: 1,
		minDetectionConfidence: 0.6,
		minTrackingConfidence: 0.5
	});

	hands.onResults((results) => {
		canvasCtx.save();
		canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
		// Draw webcam feed as cover (no side black bars). Some top/bottom crop is expected.
		const srcW = results.image.videoWidth || results.image.width || 640;
		const srcH = results.image.videoHeight || results.image.height || 480;
		const coverTransform = getCoverTransform(srcW, srcH, canvasElement.width, canvasElement.height);
		canvasCtx.drawImage(
			results.image,
			coverTransform.drawX + coverTransform.drawW,
			coverTransform.drawY,
			-coverTransform.drawW,
			coverTransform.drawH
		);

		if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
			let hasRightHand = false;
			let hasLeftIndexAnchor = false;
			let rightPinchDistance = null;
			let rightThumbLandmark = null;
			let rightIndexLandmark = null;

			for (let i = 0; i < results.multiHandLandmarks.length; i++) {
				const landmarks = remapLandmarksToCover(results.multiHandLandmarks[i], coverTransform);
				const handednessLabel = results.multiHandedness?.[i]?.label;

				window.drawConnectors(canvasCtx, landmarks, window.HAND_CONNECTIONS, { color: '#FFFFFF', lineWidth: 0.7 });
				window.drawLandmarks(canvasCtx, landmarks, { color: '#FFFFFF', lineWidth: 0.45, radius: 0.7 });

				if (handednessLabel === 'Right') {
					hasRightHand = true;
					const palm = landmarks[9];
					targetRotZ = - (palm.x - 0.5) * Math.PI * ROTATION_RANGE_MULTIPLIER;
					targetRotX = (palm.y - 0.5) * Math.PI * ROTATION_RANGE_MULTIPLIER;
					rightPinchDistance = getDistance3D(landmarks[4], landmarks[8]);
					rightThumbLandmark = landmarks[4];
					rightIndexLandmark = landmarks[8];
				}

				if (handednessLabel === 'Left' && isLeftIndexUpPose(landmarks)) {
					hasLeftIndexAnchor = true;
					targetDioramaPosition.copy(landmarkToDioramaTarget(landmarks[8]));
					targetDioramaScale = mapLeftDepthToScale(landmarks[8].z);
				}

			}

			if (!hasRightHand) {
				targetRotX = 0;
				targetRotZ = 0;
			}
			if (!hasLeftIndexAnchor) {
				targetDioramaPosition.set(0, 0, 0);
				targetDioramaScale = 0.67;
			}

			isBoxActive = hasLeftIndexAnchor;
			poolBorder.visible = isBoxActive;
			let justActivatedEmission = false;

			if (!isBoxActive) {
				emissionEnabled = false;
				wasRightHandPresent = false;
				targetParticleCount = 0;
				lastAppliedRightPinchDistance = null;
			}

			if (isBoxActive && !emissionEnabled && hasRightHand) {
				emissionEnabled = true;
				targetParticleCount = MIN_PARTICLES;
				justActivatedEmission = true;
				lastAppliedRightPinchDistance = rightPinchDistance;
			}

			if (emissionEnabled && isBoxActive) {
				// Freeze particle count while the control hand is not visible.
				if (!hasRightHand || rightPinchDistance === null) {
					targetParticleCount = params.particleCount;
					lastAppliedRightPinchDistance = null;
				} else if (!justActivatedEmission) {
					if (
						lastAppliedRightPinchDistance === null ||
						Math.abs(rightPinchDistance - lastAppliedRightPinchDistance) >= PINCH_UPDATE_DISTANCE_DELTA
					) {
						targetParticleCount = mapRightPinchToParticleCount(rightPinchDistance);
						lastAppliedRightPinchDistance = rightPinchDistance;
					}
				}
			} else {
				targetParticleCount = 0;
			}

			updatePinchIndicatorVisual(rightThumbLandmark, rightIndexLandmark, rightPinchDistance, hasRightHand);
			wasRightHandPresent = isBoxActive ? hasRightHand : false;
		} else {
			targetRotX = 0;
			targetRotZ = 0;
			targetDioramaPosition.set(0, 0, 0);
			targetDioramaScale = 0.67;
			targetParticleCount = 0;
			isBoxActive = false;
			emissionEnabled = false;
			wasRightHandPresent = false;
			lastAppliedRightPinchDistance = null;
			poolBorder.visible = false;
			updatePinchIndicatorVisual(null, null, null, false);
		}
		canvasCtx.restore();
	});

	const camera_mp = new window.Camera(videoElement, {
		onFrame: async () => {
			await hands.send({ image: videoElement });
		},
		width: 640,
		height: 480
	});
	camera_mp.start();
}

// ?뚯쟾 ?됰젹????뻾?ъ쓣 怨꾩궛?섏뿬 以묐젰 踰≫꽣瑜??뚯쟾?쒗궗 ?꾧뎄
const euler = new THREE.Euler();
const quat = new THREE.Quaternion();
const invertQuat = new THREE.Quaternion();

function render(deltaTime) {
	controls.update();
	dtUniform.value = deltaTime;

	const nextParticleCount = Math.round(THREE.MathUtils.lerp(params.particleCount, targetParticleCount, EMIT_RAMP_SPEED));
	params.particleCount = THREE.MathUtils.clamp(nextParticleCount, MIN_PARTICLES, MAX_PARTICLES);
	if (targetParticleCount <= 0) params.particleCount = 0;
	particleCountUniform.value = params.particleCount;
	particleMesh.count = params.particleCount;
	particleMesh.visible = isBoxActive;

	if (dioramaGroup) {
		dioramaGroup.position.copy(targetDioramaPosition);
		const nextScale = THREE.MathUtils.lerp(dioramaGroup.scale.x, targetDioramaScale, DIORAMA_SCALE_LERP);
		dioramaGroup.scale.setScalar(nextScale);

		// 湲곗〈 ?鍮??쇰쭏???뚯쟾?섎뒗吏 (?뚯쟾 ?띾룄 ?ㅻТ??
		const diffX = targetRotX - dioramaGroup.rotation.x;
		const diffZ = targetRotZ - dioramaGroup.rotation.z;

		dioramaGroup.rotation.x += diffX * 0.05;
		dioramaGroup.rotation.z += diffZ * 0.05;

		// ?듭떖: ?ㅼ씠?ㅻ씪留??쒖뒪?쒖씠 ?뚯쟾?덉쓣 ?? ?뚰떚?대뱾???좊━寃??섎젮硫?
		// ?꾩껜 湲곗????붾뱶)???꾨옒濡??⑥뼱吏??'以묐젰 踰≫꽣(0, -9.81, 0)'媛 
		// ?명똿???곸옄 ?대? 濡쒖뺄 醫뚰몴怨꾩뿉?쒕뒗 諛섎?濡?湲곗슱?댁?寃?苑귦옓?덈떎.
		euler.set(dioramaGroup.rotation.x, dioramaGroup.rotation.y, dioramaGroup.rotation.z, 'XYZ');
		quat.setFromEuler(euler);
		invertQuat.copy(quat).invert(); // ??쉶??

		// ?붾뱶??以묐젰(0, -9.81*n, 0)
		const gravityDir = new THREE.Vector3(0, -80.0, 0).applyQuaternion(invertQuat);
		gravityUniform.value.copy(gravityDir);
	}

	renderer.compute(workgroupKernel);
	renderer.compute(clearGridKernel);
	renderer.compute(p2g1Kernel, p2g1KernelWorkgroupBuffer);
	renderer.compute(p2g2Kernel, p2g2KernelWorkgroupBuffer);
	renderer.compute(updateGridKernel);
	renderer.compute(g2pKernel, g2pKernelWorkgroupBuffer);

	renderer.render(scene, camera);
	updateTelemetryHud();
}


