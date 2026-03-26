import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

let scene;
let camera;
let renderer;
let composer;
let rendererMode = 'INIT';
let latestHands = [];
let latestFace = null;
let handsTracker = null;
let faceTracker = null;
let faceMouthOpen = 0;
let viewportWidth = window.innerWidth;
let viewportHeight = window.innerHeight;

const MAX_PLASMA = 2;
const MAX_PASSIVE = 24;
const MAX_LINKS = 18;
const LINK_POINTS = 20;
const ORB_RADIUS = 22;
const PASSIVE_RADIUS = 12;
const MAX_FIELD_ORBS = MAX_PLASMA + MAX_PASSIVE * 3;
const MAX_FIELD_SEGMENTS = (LINK_POINTS - 1) * (MAX_LINKS + 1);
const PASSIVE_LINK_RANGE = 0.5;

const plasmaPool = [];
const passivePool = [];
const linkPool = [];
let plasmaInterLine = null;
let fieldOverlay = null;

const debug = {
    framesSent: 0,
    resultsReceived: 0,
    hands: 0,
    faces: 0,
    mouthOpen: 0,
    plasma: 0,
    passive: 0,
    links: 0,
    lastError: '-'
};

function createDebugBadge() {
    const el = document.createElement('div');
    el.id = 'debugBadge';
    el.style.position = 'absolute';
    el.style.top = '12px';
    el.style.right = '12px';
    el.style.zIndex = '30';
    el.style.padding = '8px 10px';
    el.style.background = 'rgba(0,0,0,0.45)';
    el.style.border = '1px solid rgba(255,255,255,0.4)';
    el.style.color = '#fff';
    el.style.font = '12px/1.4 monospace';
    el.style.whiteSpace = 'pre';
    el.style.pointerEvents = 'none';
    document.body.appendChild(el);
    return el;
}

async function startWebcam() {
    const video = document.querySelector('.input_video');
    const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 1280, height: 720 },
        audio: false
    });
    video.srcObject = stream;
    await new Promise((resolve) => {
        video.onloadedmetadata = resolve;
    });
    await video.play();
    console.log('[Webcam] Started');
    return video;
}

function updateViewport() {
    viewportWidth = window.innerWidth;
    viewportHeight = window.innerHeight;
    camera.left = -viewportWidth / 2;
    camera.right = viewportWidth / 2;
    camera.top = viewportHeight / 2;
    camera.bottom = -viewportHeight / 2;
    camera.updateProjectionMatrix();
    renderer.setSize(viewportWidth, viewportHeight);
    composer.setSize(viewportWidth, viewportHeight);
    for (const line of linkPool) {
        line.core.material.resolution.set(viewportWidth, viewportHeight);
        line.glow.material.resolution.set(viewportWidth, viewportHeight);
    }
    if (plasmaInterLine) {
        plasmaInterLine.core.material.resolution.set(viewportWidth, viewportHeight);
        plasmaInterLine.glow.material.resolution.set(viewportWidth, viewportHeight);
    }
    if (fieldOverlay) {
        fieldOverlay.mesh.scale.set(viewportWidth, viewportHeight, 1);
    }
}

async function initRenderer(videoEl) {
    scene = new THREE.Scene();
    camera = new THREE.OrthographicCamera(
        -viewportWidth / 2,
        viewportWidth / 2,
        viewportHeight / 2,
        -viewportHeight / 2,
        -1000,
        1000
    );
    camera.position.z = 10;

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setClearColor(0x000000, 0);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    rendererMode = 'WEBGL';

    renderer.domElement.style.position = 'absolute';
    renderer.domElement.style.top = '0';
    renderer.domElement.style.left = '0';
    renderer.domElement.style.zIndex = '2';
    renderer.domElement.style.pointerEvents = 'none';
    renderer.domElement.style.background = 'transparent';
    renderer.domElement.style.mixBlendMode = 'screen';
    document.body.appendChild(renderer.domElement);

    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const bloomPass = new UnrealBloomPass(
        new THREE.Vector2(viewportWidth, viewportHeight),
        1.65,
        0.8,
        0.05
    );
    composer.addPass(bloomPass);

    updateViewport();
    window.addEventListener('resize', updateViewport);
}

function createFieldOverlay() {
    const uniforms = {
        uTime: { value: 0 },
        uOrbCount: { value: 0 },
        uSegmentCount: { value: 0 },
        uOrbs: { value: Array.from({ length: MAX_FIELD_ORBS }, () => new THREE.Vector3(0, 0, 0)) },
        uSegStarts: { value: Array.from({ length: MAX_FIELD_SEGMENTS }, () => new THREE.Vector4(0, 0, 0, 0)) },
        uSegEnds: { value: Array.from({ length: MAX_FIELD_SEGMENTS }, () => new THREE.Vector4(0, 0, 0, 0)) }
    };

    const material = new THREE.ShaderMaterial({
        uniforms,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        vertexShader: `
            varying vec2 vWorldPos;

            void main() {
                vec4 worldPos = modelMatrix * vec4(position, 1.0);
                vWorldPos = worldPos.xy;
                gl_Position = projectionMatrix * viewMatrix * worldPos;
            }
        `,
        fragmentShader: `
            #define MAX_FIELD_ORBS ${MAX_FIELD_ORBS}
            #define MAX_FIELD_SEGMENTS ${MAX_FIELD_SEGMENTS}

            uniform float uTime;
            uniform int uOrbCount;
            uniform int uSegmentCount;
            uniform vec3 uOrbs[MAX_FIELD_ORBS];
            uniform vec4 uSegStarts[MAX_FIELD_SEGMENTS];
            uniform vec4 uSegEnds[MAX_FIELD_SEGMENTS];

            varying vec2 vWorldPos;

            float capsuleDistance(vec2 p, vec2 a, vec2 b, out float h) {
                vec2 pa = p - a;
                vec2 ba = b - a;
                float denom = max(dot(ba, ba), 0.0001);
                h = clamp(dot(pa, ba) / denom, 0.0, 1.0);
                return length(pa - ba * h);
            }

            float orbField(vec2 p, vec3 orb) {
                vec2 d = p - orb.xy;
                float rr = orb.z * orb.z;
                return rr / (dot(d, d) + rr * 0.35);
            }

            float segmentField(vec2 p, vec4 segStart, vec4 segEnd) {
                float h = 0.0;
                float d = capsuleDistance(p, segStart.xy, segEnd.xy, h);
                float radius = mix(segStart.z, segEnd.z, h);
                float rr = radius * radius;
                return segStart.w * rr / (d * d + rr * 0.32);
            }

            void main() {
                vec2 p = vWorldPos;
                float orbSum = 0.0;
                float segmentMax = 0.0;
                float hottest = 0.0;

                for (int i = 0; i < MAX_FIELD_ORBS; i++) {
                    if (i >= uOrbCount) break;
                    float f = orbField(p, uOrbs[i]);
                    orbSum += f;
                    hottest = max(hottest, f);
                }

                for (int i = 0; i < MAX_FIELD_SEGMENTS; i++) {
                    if (i >= uSegmentCount) break;
                    float f = segmentField(p, uSegStarts[i], uSegEnds[i]);
                    segmentMax = max(segmentMax, f);
                    hottest = max(hottest, f);
                }

                float field = orbSum + segmentMax * 0.92;

                float flicker = 0.97 + 0.03 * sin(uTime * 0.009 + p.x * 0.028 + p.y * 0.021 + field * 1.8);
                field *= flicker;

                float halo = smoothstep(0.24, 0.82, field);
                float body = smoothstep(0.82, 1.34, field);
                float core = smoothstep(1.4, 2.0, hottest + orbSum * 0.22 + segmentMax * 0.08);

                vec3 haloCol = vec3(0.45, 0.15, 0.95);
                vec3 bodyCol = vec3(0.20, 0.82, 1.0);
                vec3 coreCol = vec3(1.0, 0.45, 0.82);
                vec3 color = haloCol * halo * 0.14 + mix(bodyCol, coreCol, core) * body * 0.9;
                float alpha = max(halo * 0.12, body * 0.68);

                gl_FragColor = vec4(color, alpha);
            }
        `
    });

    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
    mesh.position.z = -20;
    mesh.renderOrder = 20;
    mesh.scale.set(viewportWidth, viewportHeight, 1);
    scene.add(mesh);

    return {
        mesh,
        uniforms,
        orbIndex: 0,
        segmentIndex: 0
    };
}

function makeOrb(radius, color, opacity, glowRadius, glowOpacity) {
    const group = new THREE.Group();

    const glow = new THREE.Mesh(
        new THREE.SphereGeometry(glowRadius, 24, 24),
        new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity: glowOpacity,
            blending: THREE.AdditiveBlending,
            depthWrite: false
        })
    );

    const core = new THREE.Mesh(
        new THREE.SphereGeometry(radius, 24, 24),
        new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity,
            blending: THREE.AdditiveBlending,
            depthWrite: false
        })
    );

    group.add(glow);
    group.add(core);
    group.visible = false;
    scene.add(group);
    return { group, glow, core };
}

function makeJunctionBlob(color) {
    const group = new THREE.Group();

    const glow = new THREE.Mesh(
        new THREE.CircleGeometry(1, 40),
        new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity: 0,
            blending: THREE.AdditiveBlending,
            depthWrite: false
        })
    );

    const core = new THREE.Mesh(
        new THREE.CircleGeometry(1, 40),
        new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity: 0,
            blending: THREE.AdditiveBlending,
            depthWrite: false
        })
    );

    group.add(glow);
    group.add(core);
    group.visible = false;
    scene.add(group);
    return { group, glow, core };
}

function makeLineVisual(color, coreWidth, glowWidth, coreOpacity, glowOpacity) {
    const geometryCore = new LineGeometry();
    geometryCore.setPositions(new Array(LINK_POINTS * 3).fill(0));

    const geometryGlow = new LineGeometry();
    geometryGlow.setPositions(new Array(LINK_POINTS * 3).fill(0));

    const core = new Line2(
        geometryCore,
        new LineMaterial({
            color,
            transparent: true,
            opacity: coreOpacity,
            linewidth: coreWidth,
            blending: THREE.AdditiveBlending,
            depthWrite: false
        })
    );

    const glow = new Line2(
        geometryGlow,
        new LineMaterial({
            color,
            transparent: true,
            opacity: glowOpacity,
            linewidth: glowWidth,
            blending: THREE.AdditiveBlending,
            depthWrite: false
        })
    );

    core.material.resolution.set(viewportWidth, viewportHeight);
    glow.material.resolution.set(viewportWidth, viewportHeight);
    core.visible = false;
    glow.visible = false;
    scene.add(glow);
    scene.add(core);
    return {
        core,
        glow,
        startBlob: makeJunctionBlob(0xff7de9),
        endBlob: makeJunctionBlob(0x8ef0ff)
    };
}

function buildVisualPools() {
    for (let i = 0; i < MAX_PLASMA; i++) {
        plasmaPool.push(makeOrb(ORB_RADIUS, 0xbff3ff, 0.95, 40, 0.12));
        plasmaPool[i].core.material.color.set(0x12061f);
        plasmaPool[i].core.material.blending = THREE.NormalBlending;
        plasmaPool[i].core.material.depthWrite = false;
        plasmaPool[i].core.renderOrder = 5;
    }

    for (let i = 0; i < MAX_PASSIVE; i++) {
        passivePool.push(makeOrb(PASSIVE_RADIUS, 0xf4f8ff, 0.88, 22, 0.06));
    }

    for (let i = 0; i < MAX_LINKS; i++) {
        linkPool.push(makeLineVisual(0xe4d2ff, 2.0, 7.5, 0.95, 0.22));
    }

    plasmaInterLine = makeLineVisual(0xffdcff, 3.2, 12.0, 1.0, 0.34);
}

function resetFieldOverlay() {
    fieldOverlay.orbIndex = 0;
    fieldOverlay.segmentIndex = 0;
    fieldOverlay.uniforms.uOrbCount.value = 0;
    fieldOverlay.uniforms.uSegmentCount.value = 0;
}

function pushFieldOrb(pos, radius) {
    if (fieldOverlay.orbIndex >= MAX_FIELD_ORBS) return;
    fieldOverlay.uniforms.uOrbs.value[fieldOverlay.orbIndex].set(pos.x, pos.y, radius);
    fieldOverlay.orbIndex += 1;
    fieldOverlay.uniforms.uOrbCount.value = fieldOverlay.orbIndex;
}

function pushTerminalSocket(anchor, prevPoint, activation, baseRadius = PASSIVE_RADIUS) {
    const dir = new THREE.Vector3().subVectors(prevPoint, anchor);
    const len = dir.length();
    if (len < 0.001) return;

    dir.normalize();
    if (activation <= 0.02) return;

    const socketRadius = baseRadius * THREE.MathUtils.lerp(0.0, 1.28, Math.pow(activation, 0.9));
    const neckRadius = baseRadius * THREE.MathUtils.lerp(0.0, 0.94, Math.pow(activation, 0.95));
    if (socketRadius <= 0.05 || neckRadius <= 0.05) return;
    const socket = anchor.clone().addScaledVector(dir, baseRadius * THREE.MathUtils.lerp(0.18, 0.32, activation));
    const neck = anchor.clone().addScaledVector(dir, baseRadius * THREE.MathUtils.lerp(0.55, 0.92, activation));

    pushFieldOrb(socket, socketRadius);
    pushFieldOrb(neck, neckRadius);
    pushFieldSegment(
        socket,
        neck,
        socketRadius * 0.92,
        neckRadius * 0.74,
        0.34 + activation * 0.28
    );
}

function pushFieldSegment(start, end, startRadius, endRadius, strength) {
    if (fieldOverlay.segmentIndex >= MAX_FIELD_SEGMENTS) return;
    fieldOverlay.uniforms.uSegStarts.value[fieldOverlay.segmentIndex].set(start.x, start.y, startRadius, strength);
    fieldOverlay.uniforms.uSegEnds.value[fieldOverlay.segmentIndex].set(end.x, end.y, endRadius, 0);
    fieldOverlay.segmentIndex += 1;
    fieldOverlay.uniforms.uSegmentCount.value = fieldOverlay.segmentIndex;
}

function mapToScene(lm) {
    const x = (1.0 - lm.x) * viewportWidth - viewportWidth / 2;
    const y = viewportHeight / 2 - lm.y * viewportHeight;
    return new THREE.Vector3(x, y, 0);
}

function isFingerExtended(landmarks, tipIdx, pipIdx, mcpIdx, wristIdx = 0) {
    const tip = landmarks[tipIdx];
    const pip = landmarks[pipIdx];
    const mcp = landmarks[mcpIdx];
    const wrist = landmarks[wristIdx];
    const segA = new THREE.Vector2(tip.x - pip.x, tip.y - pip.y);
    const segB = new THREE.Vector2(pip.x - mcp.x, pip.y - mcp.y);
    const straight = segA.dot(segB) > 0;
    const dwTip = Math.hypot(tip.x - wrist.x, tip.y - wrist.y);
    const dwPip = Math.hypot(pip.x - wrist.x, pip.y - wrist.y);
    return straight && dwTip > dwPip * 1.08;
}

function detectExtendedFingers(landmarks) {
    return {
        thumb: isFingerExtended(landmarks, 4, 3, 2),
        index: isFingerExtended(landmarks, 8, 6, 5),
        middle: isFingerExtended(landmarks, 12, 10, 9),
        ring: isFingerExtended(landmarks, 16, 14, 13),
        pinky: isFingerExtended(landmarks, 20, 18, 17)
    };
}

function locateMediapipeAsset(file) {
    if (/face_mesh/i.test(file)) {
        return `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`;
    }
    return `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`;
}

function initHandTracking() {
    if (!window.Hands || !window.drawConnectors || !window.drawLandmarks) {
        throw new Error('MediaPipe scripts not loaded');
    }

    const canvas = document.querySelector('.output_canvas');
    const ctx = canvas.getContext('2d');

    const resizeCanvas = () => {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
    };
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    const hands = new window.Hands({ locateFile: locateMediapipeAsset });

    hands.setOptions({
        maxNumHands: 2,
        modelComplexity: 1,
        minDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5
    });

    hands.onResults((results) => {
        debug.resultsReceived += 1;
        debug.hands = results.multiHandLandmarks ? results.multiHandLandmarks.length : 0;
        latestHands = [];

        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (!results.multiHandLandmarks) return;

        ctx.save();
        ctx.translate(canvas.width, 0);
        ctx.scale(-1, 1);

        for (let i = 0; i < results.multiHandLandmarks.length; i++) {
            const landmarks = results.multiHandLandmarks[i];
            const label = results.multiHandedness && results.multiHandedness[i]
                ? results.multiHandedness[i].label
                : `Hand${i}`;
            latestHands.push({ landmarks, label, extended: detectExtendedFingers(landmarks) });
            window.drawConnectors(ctx, landmarks, window.HAND_CONNECTIONS, { color: '#FFFFFF', lineWidth: 2 });
            window.drawLandmarks(ctx, landmarks, { color: '#00E5FF', lineWidth: 1, radius: 2 });
        }

        ctx.restore();
    });
    handsTracker = hands;
}

function avgLandmark(landmarks, indices) {
    const p = { x: 0, y: 0, z: 0 };
    for (const idx of indices) {
        p.x += landmarks[idx].x;
        p.y += landmarks[idx].y;
        p.z += landmarks[idx].z;
    }
    const inv = 1 / indices.length;
    p.x *= inv;
    p.y *= inv;
    p.z *= inv;
    return p;
}

function faceMouthOpenAmount(landmarks) {
    const upper = landmarks[13];
    const lower = landmarks[14];
    const leftFace = landmarks[234];
    const rightFace = landmarks[454];
    const mouthGap = Math.hypot(upper.x - lower.x, upper.y - lower.y);
    const faceWidth = Math.hypot(leftFace.x - rightFace.x, leftFace.y - rightFace.y);
    const ratio = mouthGap / Math.max(faceWidth, 0.0001);
    return THREE.MathUtils.clamp((ratio - 0.015) / 0.028, 0, 1);
}

function pushFaceFeaturePoints(out, landmarks, indices, scale, activation) {
    for (const idx of indices) {
        out.push({
            pos: mapToScene(landmarks[idx]),
            owner: 'Face',
            scale,
            featureActivation: activation
        });
    }
}

function extractFacePassivePoints(landmarks, mouthOpen) {
    if (mouthOpen <= 0.05) return [];

    const points = [];
    pushFaceFeaturePoints(points, landmarks, [33, 159, 133], 0.55, mouthOpen);
    pushFaceFeaturePoints(points, landmarks, [362, 386, 263], 0.55, mouthOpen);
    pushFaceFeaturePoints(points, landmarks, [98], 0.44, mouthOpen);
    pushFaceFeaturePoints(points, landmarks, [327], 0.44, mouthOpen);
    pushFaceFeaturePoints(points, landmarks, [61, 13, 14, 291], 0.6, mouthOpen);
    return points;
}

function initFaceTracking() {
    if (!window.FaceMesh) {
        throw new Error('MediaPipe FaceMesh script not loaded');
    }

    const faceMesh = new window.FaceMesh({ locateFile: locateMediapipeAsset });

    faceMesh.setOptions({
        maxNumFaces: 1,
        refineLandmarks: true,
        minDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5
    });

    faceMesh.onResults((results) => {
        const faces = results.multiFaceLandmarks || [];
        latestFace = faces.length > 0 ? faces[0] : null;
        debug.faces = faces.length;
        const targetOpen = latestFace ? faceMouthOpenAmount(latestFace) : 0;
        faceMouthOpen = THREE.MathUtils.lerp(faceMouthOpen, targetOpen, 0.3);
        debug.mouthOpen = faceMouthOpen;
    });
    faceTracker = faceMesh;
}

function initTrackingLoop(videoEl) {
    const loop = async () => {
        if (videoEl.readyState >= 2) {
            try {
                if (handsTracker) {
                    await handsTracker.send({ image: videoEl });
                }
                if (faceTracker) {
                    await faceTracker.send({ image: videoEl });
                }
                debug.framesSent += 1;
            } catch (err) {
                debug.lastError = `tracking.send failed: ${err?.message || err}`;
            }
        }
        requestAnimationFrame(loop);
    };
    loop();
}

function setLinePoints(lineVisual, points, coreWidth, glowWidth, coreOpacity, glowOpacity) {
    const flat = [];
    for (const point of points) {
        flat.push(point.x, point.y, point.z);
    }
    lineVisual.core.geometry.setPositions(flat);
    lineVisual.glow.geometry.setPositions(flat);
    lineVisual.core.material.linewidth = coreWidth;
    lineVisual.glow.material.linewidth = glowWidth;
    lineVisual.core.material.opacity = coreOpacity;
    lineVisual.glow.material.opacity = glowOpacity;
    lineVisual.core.visible = true;
    lineVisual.glow.visible = true;
}

function hideLineVisual(lineVisual) {
    lineVisual.core.visible = false;
    lineVisual.glow.visible = false;
    lineVisual.startBlob.group.visible = false;
    lineVisual.endBlob.group.visible = false;
}

function updateJunctionBlob(blob, anchor, nextPoint, mainRadius, width, opacity, elongation, flow) {
    const tangent = new THREE.Vector3().subVectors(nextPoint, anchor);
    const length = tangent.length();
    if (length < 0.001) {
        blob.group.visible = false;
        return;
    }

    tangent.normalize();
    const angle = Math.atan2(tangent.y, tangent.x);
    const offset = mainRadius * (0.14 + flow * 0.08);
    const base = anchor.clone().addScaledVector(tangent, offset);
    const longScale = mainRadius * elongation + width * (1.1 + flow * 0.5);
    const shortScale = mainRadius * (0.42 + flow * 0.12) + width * 0.55;

    blob.group.visible = true;
    blob.group.position.copy(base);
    blob.group.rotation.z = angle;
    blob.glow.scale.set(longScale * 1.35, shortScale * 1.7, 1);
    blob.core.scale.set(longScale, shortScale, 1);
    blob.glow.material.opacity = opacity * 0.42;
    blob.core.material.opacity = opacity * 0.7;
}

function updateLineJunctions(lineVisual, points, startRadius, endRadius, width, opacity, flow = 1) {
    if (points.length < 3) {
        lineVisual.startBlob.group.visible = false;
        lineVisual.endBlob.group.visible = false;
        return;
    }

    updateJunctionBlob(lineVisual.startBlob, points[0], points[2], startRadius, width, opacity, 1.05, flow);
    updateJunctionBlob(lineVisual.endBlob, points[points.length - 1], points[points.length - 3], endRadius, width, opacity * 0.78, 0.72, flow * 0.85);
}

function buildArcPoints(start, end, wobbleA, wobbleB, seed, activation) {
    const dir = new THREE.Vector3().subVectors(end, start).normalize();
    const up = new THREE.Vector3(0, 0, 1);
    const side = new THREE.Vector3().crossVectors(dir, up);
    if (side.lengthSq() < 0.0001) {
        side.set(0, 1, 0);
    } else {
        side.normalize();
    }
    const up2 = new THREE.Vector3().crossVectors(side, dir).normalize();

    const points = [];
    const time = performance.now() * 0.006;
    const noiseGain = THREE.MathUtils.lerp(0.35, 1.55, activation);
    const spikeGain = THREE.MathUtils.lerp(0.08, 0.42, activation);
    for (let i = 0; i < LINK_POINTS; i++) {
        const t = i / (LINK_POINTS - 1);
        const point = new THREE.Vector3().lerpVectors(start, end, t);
        const envelope = Math.sin(t * Math.PI);
        const driftA =
            Math.sin(t * 8.5 + time * 0.75 + seed * 1.7) * 0.55 +
            Math.sin(t * 15.0 - time * 1.15 + seed * 0.9) * 0.25;
        const driftB =
            Math.cos(t * 10.5 - time * 0.65 + seed * 1.3) * 0.5 +
            Math.sin(t * 19.0 + time * 1.35 + seed * 2.1) * 0.22;
        const rippleA =
            Math.sin(t * 33.0 - time * 2.4 + seed * 3.7) * 0.18 +
            Math.sin(t * 51.0 + time * 3.1 + seed * 1.4) * 0.12;
        const rippleB =
            Math.cos(t * 29.0 + time * 2.2 + seed * 2.8) * 0.16 +
            Math.sin(t * 47.0 - time * 2.9 + seed * 4.2) * 0.1;
        const spikes =
            Math.pow(Math.max(0, Math.sin(t * 24.0 - time * 4.8 + seed * 5.3)), 6.0) +
            0.6 * Math.pow(Math.max(0, Math.cos(t * 18.0 + time * 3.9 + seed * 2.6)), 8.0);
        const sideOffset = (driftA + rippleA * noiseGain + spikes * spikeGain) * wobbleA * envelope;
        const upOffset = (driftB + rippleB * noiseGain + spikes * spikeGain * 0.7) * wobbleB * envelope;
        point.addScaledVector(side, sideOffset);
        point.addScaledVector(up2, upOffset);
        points.push(point);
    }
    return points;
}

function updateVisuals() {
    const plasmaSources = [];
    const passiveSources = [];
    resetFieldOverlay();
    fieldOverlay.uniforms.uTime.value = performance.now();

    for (const hand of latestHands) {
        plasmaSources.push({
            pos: mapToScene(hand.landmarks[8]),
            label: hand.label
        });

        if (hand.extended.thumb) passiveSources.push({ pos: mapToScene(hand.landmarks[4]), owner: hand.label, scale: 1.0, featureActivation: 1.0 });
        if (hand.extended.middle) passiveSources.push({ pos: mapToScene(hand.landmarks[12]), owner: hand.label, scale: 1.0, featureActivation: 1.0 });
        if (hand.extended.ring) passiveSources.push({ pos: mapToScene(hand.landmarks[16]), owner: hand.label, scale: 1.0, featureActivation: 1.0 });
        if (hand.extended.pinky) passiveSources.push({ pos: mapToScene(hand.landmarks[20]), owner: hand.label, scale: 1.0, featureActivation: 1.0 });
    }

    if (latestFace) {
        passiveSources.push(...extractFacePassivePoints(latestFace, faceMouthOpen));
    }

    for (let i = 0; i < plasmaPool.length; i++) {
        const orb = plasmaPool[i];
        const src = plasmaSources[i];
        if (!src) {
            orb.group.visible = false;
            continue;
        }
        const pulse = 1 + Math.sin(performance.now() * 0.014 + i * 0.8) * 0.08;
        orb.group.visible = true;
        orb.group.position.copy(src.pos);
        orb.core.visible = true;
        orb.glow.visible = false;
        orb.core.scale.setScalar(1.05 + pulse * 0.08);
        orb.glow.scale.setScalar(1.0);
        orb.glow.material.opacity = 0.0;
        orb.core.material.opacity = 1.0;
        pushFieldOrb(src.pos, ORB_RADIUS * (1.08 + pulse * 0.05));
    }

    for (let i = 0; i < passivePool.length; i++) {
        const orb = passivePool[i];
        const src = passiveSources[i];
        if (!src) {
            orb.group.visible = false;
            continue;
        }
        const pulse = 1 + Math.sin(performance.now() * 0.012 + i * 0.6) * 0.05;
        orb.group.visible = true;
        orb.group.position.copy(src.pos);
        orb.core.visible = false;
        orb.glow.visible = false;
        orb.core.scale.setScalar(pulse);
        orb.glow.scale.setScalar(1.0);
        orb.glow.material.opacity = 0.0;
        orb.core.material.opacity = 0.0;
    }

    for (const link of linkPool) {
        hideLineVisual(link);
    }
    hideLineVisual(plasmaInterLine);

    if (plasmaSources.length >= 2) {
        const start = plasmaSources[0].pos;
        const end = plasmaSources[1].pos;
        const dist = start.distanceTo(end);
        const activation = THREE.MathUtils.clamp(1 - dist / (viewportWidth * 0.42), 0.12, 1);
        const points = buildArcPoints(
            start,
            end,
            THREE.MathUtils.lerp(26, 4, activation),
            THREE.MathUtils.lerp(12, 2, activation),
            0.0,
            activation
        );
        for (let p = 0; p < points.length - 1; p++) {
            const t0 = p / (points.length - 1);
            const t1 = (p + 1) / (points.length - 1);
            pushFieldSegment(
                points[p],
                points[p + 1],
                THREE.MathUtils.lerp(ORB_RADIUS * 0.68, ORB_RADIUS * 0.42, Math.sin(t0 * Math.PI)),
                THREE.MathUtils.lerp(ORB_RADIUS * 0.68, ORB_RADIUS * 0.42, Math.sin(t1 * Math.PI)),
                0.52 + activation * 0.42
            );
        }
        plasmaPool[0].glow.visible = false;
        plasmaPool[1].glow.visible = false;
    }

    let linkCount = 0;
    for (let i = 0; i < passiveSources.length && linkCount < MAX_LINKS; i++) {
        const passive = passiveSources[i];
        let target = null;
        let bestDist = Number.POSITIVE_INFINITY;
        for (const plasma of plasmaSources) {
            if (plasmaSources.length > 1 && plasma.label === passive.owner) continue;
            const dist = passive.pos.distanceTo(plasma.pos);
            if (dist < bestDist) {
                bestDist = dist;
                target = plasma;
            }
        }
        if (!target) continue;

        const activation = THREE.MathUtils.clamp(1 - bestDist / (viewportWidth * PASSIVE_LINK_RANGE), 0, 1);
        if (activation <= 0.02) {
            continue;
        }

        const sourceScale = passive.scale || 1.0;
        const featureActivation = passive.featureActivation || 1.0;
        const passiveRadius = PASSIVE_RADIUS * sourceScale * Math.pow(activation * featureActivation, 0.85);
        if (passiveRadius <= 0.05) {
            continue;
        }
        pushFieldOrb(passive.pos, passiveRadius);
        const points = buildArcPoints(
            target.pos,
            passive.pos,
            THREE.MathUtils.lerp(18, 3, activation),
            THREE.MathUtils.lerp(10, 1.5, activation),
            i * 0.9,
            activation
        );
        for (let p = 0; p < points.length - 1; p++) {
            const t0 = p / (points.length - 1);
            const t1 = (p + 1) / (points.length - 1);
            const startRadius = THREE.MathUtils.lerp(ORB_RADIUS * (0.58 + activation * 0.1), passiveRadius * 0.95, Math.pow(t0, 0.78));
            const endRadius = THREE.MathUtils.lerp(ORB_RADIUS * (0.58 + activation * 0.1), passiveRadius * 0.95, Math.pow(t1, 0.78));
            pushFieldSegment(
                points[p],
                points[p + 1],
                startRadius,
                endRadius,
                0.12 + activation * 0.46
            );
        }
        if (points.length >= 3) {
            pushTerminalSocket(points[points.length - 1], points[points.length - 3], activation * featureActivation, passiveRadius);
        }

        if (passivePool[i]) {
            passivePool[i].glow.visible = false;
        }
        linkCount += 1;
    }

    debug.plasma = Math.min(plasmaSources.length, MAX_PLASMA);
    debug.passive = Math.min(passiveSources.length, MAX_PASSIVE);
    debug.links = linkCount + (plasmaSources.length >= 2 ? 1 : 0);
}

function animate() {
    requestAnimationFrame(animate);
    updateVisuals();
    composer.render();
}

(async () => {
    const badge = createDebugBadge();

    try {
        const videoEl = await startWebcam();
        await initRenderer(videoEl);
        fieldOverlay = createFieldOverlay();
        buildVisualPools();
        initHandTracking();
        initFaceTracking();
        initTrackingLoop(videoEl);
        animate();

        setInterval(() => {
            badge.textContent =
`renderer: ${rendererMode}
framesSent: ${debug.framesSent}
resultsReceived: ${debug.resultsReceived}
hands: ${debug.hands}
faces: ${debug.faces}
mouthOpen: ${debug.mouthOpen.toFixed(2)}
plasma: ${debug.plasma}
passive: ${debug.passive}
links: ${debug.links}
lastError: ${debug.lastError}`;
        }, 120);
    } catch (err) {
        console.error('[Fatal]', err);
        badge.textContent = `FATAL\n${err?.message || err}`;
    }
})();
