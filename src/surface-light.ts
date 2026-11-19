import * as THREE from 'three';
import { dimensions, type createMachine, type PartId, type ViewMode } from './model.ts';

const period = 3600;
const passage = 1560;

/** 每次定位先扫过一遍部件，之后低频重复；减少动态效果时只保留稳定的边缘光。 */
export function sampleSurfaceLight(elapsed: number, reduced: boolean) {
  if (reduced) return { head: 0, sweep: 0, breath: .55 };
  const time = Math.max(0, elapsed - 190);
  const phase = (time % period) / passage;
  const fade = THREE.MathUtils.smoothstep(phase, 0, .16) * (1 - THREE.MathUtils.smoothstep(phase, .82, 1));
  return {
    head: THREE.MathUtils.lerp(-.14, 1.14, Math.min(1, phase)),
    sweep: fade * (time < period ? 1 : .65),
    breath: .5 - .5 * Math.cos(time / period * 2 * Math.PI),
  };
}

/** 把光带绑定到实际的刀盘、斜轴和盾壳表面，共用地图的深度关系。 */
export function createSurfaceLight(machine: ReturnType<typeof createMachine>) {
  machine.root.updateMatrixWorld(true);

  function surfaceAxis(node: THREE.Object3D, localDirection: THREE.Vector3, start: number, length: number) {
    const direction = localDirection.transformDirection(node.matrixWorld).divideScalar(length);
    const origin = node.getWorldPosition(new THREE.Vector3());
    return new THREE.Vector4(direction.x, direction.y, direction.z, -direction.dot(origin) - start / length);
  }

  const { cutterDiameter, augerLength, shieldLength } = dimensions;
  const axes = {
    cutterhead: surfaceAxis(machine.meshGroups.cutter, new THREE.Vector3(0, .82, -.57), -cutterDiameter / 2, cutterDiameter),
    auger_screw: surfaceAxis(machine.meshGroups.auger, new THREE.Vector3(1, 0, 0), 0, augerLength),
    shield: surfaceAxis(machine.meshGroups.full, new THREE.Vector3(1, 0, 0), -shieldLength / 2, shieldLength),
  };
  const strength = { value: 0 };
  const waveHead = { value: 0 };
  const waveStrength = { value: 0 };
  const breath = { value: 0 };
  const partAxis = { value: axes.shield };
  const lightColor = { value: new THREE.Color() };
  const eye = { value: new THREE.Vector3() };
  const clipEye = new THREE.Vector4();
  const uniforms = { focusStrength: strength, focusWaveHead: waveHead, focusWaveStrength: waveStrength,
    focusBreath: breath, focusAxis: partAxis, focusColor: lightColor, focusEye: eye };

  function attach(material: THREE.MeshStandardMaterial, translucent = false) {
    const compile = material.onBeforeCompile;
    const cacheKey = material.customProgramCacheKey();
    material.customProgramCacheKey = () => `${cacheKey}:surface-light:${translucent}`;
    material.onBeforeCompile = (shader, renderer) => {
      compile.call(material, shader, renderer);
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = `varying vec3 focusPosition;\n${shader.vertexShader}`.replace('#include <begin_vertex>', `
        #include <begin_vertex>
        focusPosition = (modelMatrix * vec4(position, 1.0)).xyz;
      `);
      shader.fragmentShader = `
        varying vec3 focusPosition;
        uniform vec3 focusEye;
        uniform vec3 focusColor;
        uniform vec4 focusAxis;
        uniform float focusStrength;
        uniform float focusWaveHead;
        uniform float focusWaveStrength;
        uniform float focusBreath;
        ${shader.fragmentShader}
      `.replace('#include <tonemapping_fragment>', `
        if (focusStrength > 0.0) {
          float distanceToWave = dot(vec4(focusPosition, 1.0), focusAxis) - focusWaveHead;
          float waveDistance = distanceToWave * 24.0;
          float crest = exp(-waveDistance * waveDistance);
          float tail = exp(-abs(distanceToWave) * 10.0);
          float facing = abs(dot(normal, normalize(focusEye - focusPosition)));
          float edge = pow(clamp(1.0 - facing, 0.0, 1.0), 2.2);
          vec3 hot = mix(focusColor, vec3(1.0, 0.97, 0.84), 0.59);
          gl_FragColor.rgb += focusStrength * (focusColor * (edge * (0.34 + 0.60 * focusBreath)
            + tail * focusWaveStrength * 0.78) + hot * crest * focusWaveStrength * 1.65);
          ${translucent ? 'gl_FragColor.a = min(0.68, gl_FragColor.a + focusStrength * (edge * (0.06 + 0.10 * focusBreath) + focusWaveStrength * (0.24 * crest + 0.12 * tail)));' : ''}
        }
        #include <tonemapping_fragment>
      `);
    };
  }

  function update(mode: ViewMode, part: PartId | null, reveal: number, elapsed: number, reduced: boolean, inverseProjection: THREE.Matrix4) {
    if (!part || (mode === 'xray' && (part !== 'shield' || reveal <= 0))) {
      strength.value = 0;
      return false;
    }
    strength.value = mode === 'xray' ? THREE.MathUtils.smoothstep(reveal, .32, 1) : 1;
    partAxis.value = axes[part];
    lightColor.value.setHex(mode === 'xray' ? 0x32bdfa : 0xffa83a);
    const frame = sampleSurfaceLight(elapsed, reduced);
    waveHead.value = frame.head;
    waveStrength.value = frame.sweep;
    breath.value = frame.breath;
    // 地图视图矩阵合并在投影矩阵中，反投影得到相机位置，让边缘光随视角变化。
    clipEye.set(0, 0, 1, 0).applyMatrix4(inverseProjection);
    if (Math.abs(clipEye.w) > 1e-8) eye.value.set(clipEye.x / clipEye.w, clipEye.y / clipEye.w, clipEye.z / clipEye.w);
    return !reduced;
  }

  return { attach, update };
}
