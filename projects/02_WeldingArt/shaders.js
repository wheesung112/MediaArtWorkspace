export const vertexShader = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const fragmentShader = `
varying vec2 vUv;
uniform float uTime;
uniform sampler2D tMask;
uniform sampler2D tVideo;
uniform vec2 uVideoSize;

// Ashima Arts 2D Simplex Noise
vec3 permute(vec3 x) { return mod(((x*34.0)+1.0)*x, 289.0); }
float snoise(vec2 v){
  const vec4 C = vec4(0.211324865405187, 0.366025403784439,
           -0.577350269189626, 0.024390243902439);
  vec2 i  = floor(v + dot(v, C.yy) );
  vec2 x0 = v -   i + dot(i, C.xx);
  vec2 i1;
  i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod(i, 289.0);
  vec3 p = permute( permute( i.y + vec3(0.0, i1.y, 1.0 ))
  + i.x + vec3(0.0, i1.x, 1.0 ));
  vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy),
    dot(x12.zw,x12.zw)), 0.0);
  m = m*m;
  m = m*m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * ( a0*a0 + h*h );
  vec3 g;
  g.x  = a0.x  * x0.x  + h.x  * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}

void main() {
  vec2 uv = vUv;
  float screenAspect = 1280.0 / 720.0;
  float videoAspect = uVideoSize.x > 0.0 ? uVideoSize.x / uVideoSize.y : 4.0/3.0; 
  
  vec2 videoUv = uv;
  if (screenAspect > videoAspect) {
    videoUv.x = (videoUv.x - 0.5) * (screenAspect / videoAspect) + 0.5;
  } else {
    videoUv.y = (videoUv.y - 0.5) * (videoAspect / screenAspect) + 0.5;
  }
  
  vec4 maskData = texture2D(tMask, uv);
  float maskVal = maskData.r;   // 지우개(Melt) 채널: 0.0 -> 2.5 로 쌓이며 화면을 녹임
  float flameVal = maskData.g;  // 오로라(Flame) 채널: 0.0 -> 1.0 으로 요동치며 위로 솟구침
  
  float noise = snoise(uv * 15.0 + uTime * 2.5) * 0.5 + 0.5; 
  float distortedMask = maskVal - (1.0 - noise) * 0.35; 
  
  vec3 finalColor = vec3(0.0);
  bool isOutside = videoUv.x < 0.0 || videoUv.x > 1.0 || videoUv.y < 0.0 || videoUv.y > 1.0;

  // --- 1. 배경을 지우는 용접 구멍 페이즈 (Melt 채널) ---
  if (distortedMask > 2.0) {
    finalColor = isOutside ? vec3(0.0) : texture2D(tVideo, videoUv).rgb;
  } else if (distortedMask > 0.6) {
    float fadeOut = smoothstep(2.0, 0.6, distortedMask); 
    float strength = 0.03 * fadeOut; 
    
    vec2 offset1 = vec2(strength * snoise(uv * 20.0 - uTime), 0.0);
    vec2 offset2 = vec2(0.0, strength * snoise(uv * 20.0 + uTime));
    
    if (isOutside) {
       finalColor = vec3(0.0);
    } else {
       float r = texture2D(tVideo, videoUv + offset1).r;
       float g = texture2D(tVideo, videoUv + offset2).g;
       float b = texture2D(tVideo, videoUv).b;
       finalColor = vec3(r, g, b);
    }
  } else if (distortedMask > 0.4) {
    float intensity = smoothstep(0.4, 0.6, distortedMask);
    intensity = 1.0 - abs(intensity - 0.5) * 2.0; 
    finalColor = vec3(1.5, 0.5, 0.1) * intensity * 2.5; 
  }

  // --- 2. 제자리 그라데이션 빛 페이즈 (Flame 채널) ---
  if (flameVal > 0.01) {
    // 하얗게 타버리지 않도록 전체적인 출력값을 살짝 눌러줌
    vec3 colLow = vec3(0.0, 0.6, 2.0);   // 외곽 (시안/푸른색)
    vec3 colMid = vec3(2.0, 0.0, 1.5);   // 중간 (마젠타/핑크)
    vec3 colHigh = vec3(2.5, 1.5, 0.0);  // 중심 코어 (주황/노랑)
    
    vec3 flameColor = vec3(0.0);
    // 색상이 고르게 분포되도록 그라데이션 비율(0.5) 조정
    if (flameVal < 0.5) {
      flameColor = mix(colLow, colMid, flameVal / 0.5);
    } else {
      flameColor = mix(colMid, colHigh, smoothstep(0.5, 1.0, flameVal));
    }
    
    // 잔잔한 노이즈 질감 추가
    float fNoise = snoise(uv * 30.0 - vec2(0.0, uTime * 2.0)) * 0.5 + 0.5;
    flameColor *= (fNoise * 0.5 + 0.5);
    
    // 가장자리 외곽 투명도 부드럽게 감쇄
    flameColor *= smoothstep(0.0, 0.15, flameVal);
    
    // Bloom 뻥튀기 배율을 확 줄임 (기존 2.5에서 1.0 수준으로)
    flameColor *= 1.2; 
    
    finalColor += flameColor;
  }
  
  gl_FragColor = vec4(finalColor, 1.0);
}
`;
