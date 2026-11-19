import * as THREE from 'three';
import { dimensions, type createMachine, type PartId, type ViewMode } from './model.ts';
import { createSurfaceLight } from './surface-light.ts';

type Machine = ReturnType<typeof createMachine>;
const highlightColor = new THREE.Color(0x1ab8ff);
const highlightGlow = new THREE.Color(0x007edf);
const tau = Math.PI * 2;

/** 沿机器纵轴扫过，逐段将原材质换成半透明蓝色；反向过渡时使用同一个扫掠参数。 */
function scanMaterial(material: THREE.Material, opacity: { value: number }, axis: THREE.Vector4, progress: { value: number }) {
  material.transparent = true;
  material.depthWrite = false;
  material.forceSinglePass = true;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.revealAxis = { value: axis };
    shader.uniforms.revealProgress = progress;
    shader.uniforms.ghostOpacity = opacity;
    shader.vertexShader = `uniform vec4 revealAxis;\nvarying float machineAxial;\n${shader.vertexShader}`.replace('#include <begin_vertex>', `
      #include <begin_vertex>
      machineAxial = dot(modelMatrix * vec4(position, 1.0), revealAxis);
    `);
    shader.fragmentShader = `uniform float revealProgress;\nuniform float ghostOpacity;\nvarying float machineAxial;\n${shader.fragmentShader}`.replace('#include <tonemapping_fragment>', `
      float distanceFromScan = mix(-5.7, 9.1, revealProgress) - machineAxial;
      float revealed = smoothstep(-0.62, 0.62, distanceFromScan);
      float band = (1.0 - smoothstep(0.02, 0.33, abs(distanceFromScan))) * (1.0 - smoothstep(0.87, 1.0, revealProgress));
      vec3 surface = mix(gl_FragColor.rgb, vec3(0.07, 0.38, 0.62), revealed * 0.86);
      gl_FragColor.rgb = mix(surface, vec3(0.025, 0.74, 1.0), band * 0.79);
      gl_FragColor.a *= max(mix(1.0, ghostOpacity, revealed), 0.73 * band);
      #include <tonemapping_fragment>
    `);
  };
  material.customProgramCacheKey = () => 'machine-scan';
}

/** 只描摹可读的环线、稀疏纵线和轮廓，不绘制工业模型密集的小三角面。 */
function cylinderGrid(length: number, radius: number, offset = 0, rings = 8, rails = 20) {
  const positions: number[] = [];
  const point = (axial: number, angle: number) => [axial + offset, Math.cos(angle) * radius, Math.sin(angle) * radius];
  for (let ring = 0; ring < rings; ring++) {
    const axial = length * (ring / (rings - 1) - .5);
    for (let index = 0; index < 80; index++) positions.push(...point(axial, index * tau / 80), ...point(axial, (index + 1) * tau / 80));
  }
  for (let rail = 0; rail < rails; rail++) positions.push(...point(-length / 2, rail * tau / rails), ...point(length / 2, rail * tau / rails));
  return new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
}

function cageMaterial(color: number) {
  return new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0, depthWrite: false, toneMapped: false });
}

/** 两种展示共用现有网格和转轴；透视只改变材质与线框，不换场景或重置相位。 */
export function createPresentation(machine: Machine) {
  const { full, frame, cutter, casing, ends, auger } = machine.meshGroups;
  const surfaceLight = createSurfaceLight(machine);
  for (const material of machine.sectionMaterials) surfaceLight.attach(material);
  const ghostSurfaces: { object: THREE.Mesh; original: THREE.MeshStandardMaterial; focused: THREE.MeshStandardMaterial | null; ghost: THREE.Material; part?: PartId }[] = [];
  const allocated = new Set<THREE.Material | THREE.BufferGeometry>();
  machine.root.updateMatrixWorld(true);
  const direction = new THREE.Vector3(1, 0, 0).transformDirection(machine.root.matrixWorld);
  const axis = new THREE.Vector4(direction.x, direction.y, direction.z, -direction.dot(machine.root.getWorldPosition(new THREE.Vector3())));
  const progress = { value: 0 };

  function register(group: THREE.Group, baseOpacity: number, part?: PartId) {
    const opacity = { value: baseOpacity };
    const materials = new Map<THREE.MeshStandardMaterial, Pick<(typeof ghostSurfaces)[number], 'focused' | 'ghost'>>();
    group.traverse((object) => {
      if (!(object instanceof THREE.Mesh) || !(object.material instanceof THREE.MeshStandardMaterial)) return;
      // 材质在多个部件间复用；必须分组克隆，避免让选中的转子和包围它的筒壁一起变透明。
      const original = object.material;
      let variants = materials.get(original);
      if (!variants) {
        const ghost = original.clone();
        const focused = part ? original.clone() : null;
        variants = { ghost, focused };
        scanMaterial(ghost, opacity, axis, progress);
        if (group === full) surfaceLight.attach(ghost, true);
        materials.set(original, variants);
        allocated.add(ghost);
        if (focused) allocated.add(focused);
      }
      ghostSurfaces.push({ object, original, ...variants, part });
    });
    return opacity;
  }

  const shieldOpacity = register(full, .052);
  register(frame, .075);
  register(casing, .05);
  register(ends, .115);
  register(cutter, .12, 'cutterhead');
  register(auger, .115, 'auger_screw');

  const shieldLines = cageMaterial(0x4299c2);
  const screwLines = cageMaterial(0x53a8ce);
  const cutterLines = cageMaterial(0x438cb4);
  for (const material of [shieldLines, screwLines, cutterLines]) allocated.add(material);

  function addCage(parent: THREE.Group, geometry: THREE.BufferGeometry, material: THREE.LineBasicMaterial) {
    const lines = new THREE.LineSegments(geometry, material);
    lines.raycast = () => {};
    lines.renderOrder = 3;
    lines.visible = false;
    parent.add(lines);
    allocated.add(geometry);
    return lines;
  }

  const shieldCage = addCage(full, cylinderGrid(dimensions.shieldLength, dimensions.cutterDiameter / 2 + .037), shieldLines);
  const screwCage = addCage(casing, cylinderGrid(11.85, .64, 6, 12, 8), screwLines);
  const cutterCage = addCage(cutter, cylinderGrid(.39, dimensions.cutterDiameter / 2 + .035, -.1, 2, 20), cutterLines);
  let lastMode: ViewMode | null = null;
  let lastPart: PartId | null = null;
  let lastProgress = -1;

  function apply(mode: ViewMode, part: PartId | null, reveal: number) {
    const strength = mode === 'xray' ? THREE.MathUtils.clamp(reveal, 0, 1) : 0;
    if (mode === lastMode && part === lastPart && strength === lastProgress) return;
    const translucent = strength > 0;
    if (lastMode === 'xray' && mode !== 'xray') restoreGhostSurfaces();
    if (mode !== lastMode || part !== lastPart) {
      machine.setHighlight(mode === 'cutaway' ? part : null, mode === 'cutaway' && part === 'auger_screw');
    }
    // 透视材质不能覆盖剖视高亮；盾壳选中时保留内部可见，仅光带扫过处局部变亮。
    if (mode === 'xray') {
      progress.value = strength;
      shieldOpacity.value = part === 'shield' ? .10 : .052;
      for (const { object, original, focused, ghost, part: owner } of ghostSurfaces) {
        const emphasized = translucent && focused && part === owner;
        if (emphasized) {
          focused.color.copy(original.color).lerp(highlightColor, .77 * strength);
          focused.emissive.copy(highlightGlow);
          focused.emissiveIntensity = .44 * strength;
          object.material = focused;
        } else {
          object.material = translucent ? ghost : original;
        }
        // 透视完成后优先命中内部，无内部命中时仍可点选外壳。
        object.userData.transparentToPick = translucent && strength >= .78 && !emphasized;
      }
    }
    const wire = THREE.MathUtils.smoothstep(strength, .14, .89);
    shieldLines.opacity = wire * (part === 'shield' ? .79 : .61);
    shieldLines.color.setHex(part === 'shield' ? 0x3382b7 : 0x428bb3);
    screwLines.opacity = wire * (part === 'shield' ? .24 : .43);
    screwLines.color.setHex(part === 'auger_screw' ? 0x259cca : 0x53a8ce);
    cutterLines.opacity = wire * (part === 'shield' ? .28 : part === 'cutterhead' ? .37 : .52);
    shieldCage.visible = screwCage.visible = cutterCage.visible = wire > 0;
    lastMode = mode;
    lastPart = part;
    lastProgress = strength;
  }

  function restoreGhostSurfaces() {
    for (const { object, original } of ghostSurfaces) {
      object.material = original;
      delete object.userData.transparentToPick;
    }
  }

  return {
    apply,
    updateLight(elapsed: number, reduced: boolean, inverseProjection: THREE.Matrix4) {
      return lastMode !== null && surfaceLight.update(lastMode, lastPart, lastProgress, elapsed, reduced, inverseProjection);
    },
    dispose() {
      if (lastMode === 'xray') restoreGhostSurfaces();
      for (const detail of [shieldCage, screwCage, cutterCage]) detail.removeFromParent();
      for (const resource of allocated) resource.dispose();
    },
  };
}

/** 重定向过渡时从当前画面继续，避免连续点选导致材质突然跳回实体。 */
export function createReveal() {
  let from = 0;
  let to = 0;
  let start = 0;
  let end = 0;
  const value = (now: number) => end > now ? THREE.MathUtils.lerp(from, to, THREE.MathUtils.smoothstep(now, start, end)) : to;
  return {
    value,
    active(now: number) { return now < end; },
    go(target: number, now: number, duration: number, delay = 0) {
      from = value(now);
      to = target;
      start = now + delay;
      end = from === to || duration <= 0 ? now : start + duration;
    },
  };
}
