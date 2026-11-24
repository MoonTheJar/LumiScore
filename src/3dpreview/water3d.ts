// ── 水面：不透明纯反射 + 轻微波浪 ────────────────────────────────
// 用 three/addons 的 Reflector 把场景镜像到水平面；波浪只做顶点位移（反射
// 纹理按顶点投影自动扭曲）。约束：波峰/波谷幅度永远小于给定上限（即乐谱浮起
// 的高度），谱面静止在水面上方、只有水在动。
import * as THREE from 'three'
import { Reflector } from 'three/examples/jsm/objects/Reflector.js'

export interface WaterOptions {
  width: number
  depth: number
  /** 水面中心（世界 XZ；Y 固定 0 略低于乐谱） */
  x: number
  z: number
  y: number
  color: number
  /** 波幅上限（世界单位）：波峰不超过乐谱高度 */
  maxAmplitude: number
  textureWidth?: number
  textureHeight?: number
}

export class WaterSurface {
  readonly mesh: Reflector
  private base: Float32Array
  private segX: number
  private segZ: number
  private amp: number
  private maxAmp: number
  private time = 0
  private speed = 0.6
  private waveLength = 1.4
  enabled = true

  constructor(opts: WaterOptions) {
    const tw = opts.textureWidth ?? 1024
    const th = opts.textureHeight ?? 1024
    this.segX = 120
    this.segZ = 24
    const geo = new THREE.PlaneGeometry(opts.width, opts.depth, this.segX, this.segZ)
    const col = new THREE.Color(opts.color)
    this.mesh = new Reflector(geo, {
      clipBias: 0.003,
      textureWidth: tw,
      textureHeight: th,
      color: col.getHex(),
    } as never)
    this.mesh.rotation.x = -Math.PI / 2
    this.mesh.position.set(opts.x, opts.y, opts.z)
    this.base = (geo.attributes.position as THREE.BufferAttribute).array.slice(0) as Float32Array
    this.maxAmp = Math.max(0, opts.maxAmplitude)
    this.amp = Math.min(this.maxAmp, this.maxAmp * 0.6)
    // Reflector 默认材质偏亮，压一点透明度感（它本身不透明，只反射）
    const mat = this.mesh.material as THREE.ShaderMaterial
    mat.uniforms.color!.value = col
  }

  /** 波幅（钳制在上限内，绝不超过乐谱浮起高度） */
  setAmplitude(a: number): void {
    this.amp = Math.max(0, Math.min(this.maxAmp, a))
  }
  setSpeed(v: number): void { this.speed = Math.max(0, v) }
  setWaveLength(v: number): void { this.waveLength = Math.max(0.2, v) }
  setColor(hex: number): void {
    const mat = this.mesh.material as THREE.ShaderMaterial
    (mat.uniforms.color!.value as THREE.Color).setHex(hex)
  }
  setVisible(v: boolean): void {
    this.enabled = v
    this.mesh.visible = v
  }
  /** 水面跟随相机焦点平移（只铺焦点周围区域，省反射渲染面积） */
  setCenterX(x: number): void {
    this.mesh.position.x = x
  }

  update(dt: number): void {
    if (!this.enabled || this.amp <= 0) return
    this.time += dt * this.speed
    const pos = this.mesh.geometry.attributes.position as THREE.BufferAttribute
    const arr = pos.array as Float32Array
    const k = (Math.PI * 2) / this.waveLength
    for (let i = 0; i < arr.length; i += 3) {
      const lx = this.base[i]!
      const ly = this.base[i + 1]!
      // 两个方向的行波叠加，幅度钳在 ±amp（amp≤乐谱浮起高度）
      arr[i + 2] =
        Math.sin(lx * k + this.time) * this.amp * 0.6 +
        Math.cos(ly * k * 0.7 - this.time * 1.3) * this.amp * 0.4
    }
    pos.needsUpdate = true
    // 反射投影随波浪走，不需要 computeVertexNormals（纯反射平面无光照）
  }

  dispose(): void {
    this.mesh.geometry.dispose()
    ;(this.mesh.material as THREE.Material).dispose()
    const rt = (this.mesh as unknown as { getRenderTarget?: () => THREE.WebGLRenderTarget }).getRenderTarget?.()
    rt?.dispose()
  }
}
