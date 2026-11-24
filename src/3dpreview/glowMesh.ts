// ── 球光晕（three-glow-mesh 算法的现代 three 移植） ──────────────
// npm 的 three-glow-mesh@0.1.2 依赖旧版 three 的 Face3 / legacy Geometry，
// 在 three ≥0.155 无法打包运行；此文件按其原始算法（MIT）用 BufferGeometry
// 重写：顶点沿法线外扩 size + 背面菲涅尔外壳，参数与原库一致。
import * as THREE from "three";

export interface GlowOptions {
	backside: boolean;
	coefficient: number;
	color: string;
	size: number;
	power: number;
}

export const defaultGlowOptions: GlowOptions = {
	backside: true,
	coefficient: 0.5,
	color: "gold",
	size: 2,
	power: 1,
};

function createGlowMaterial(
	coefficient: number,
	color: string,
	power: number,
): THREE.ShaderMaterial {
	return new THREE.ShaderMaterial({
		depthWrite: false,
		transparent: true,
		uniforms: {
			coefficient: { value: coefficient },
			color: { value: new THREE.Color(color) },
			power: { value: power },
		},
		vertexShader: /* glsl */ `
    varying vec3 vVertexNormal;
    varying vec3 vVertexWorldPosition;
    void main() {
      vVertexNormal = normalize(normalMatrix * normal);
      vVertexWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
		fragmentShader: /* glsl */ `
    uniform vec3 color;
    uniform float coefficient;
    uniform float power;
    varying vec3 vVertexNormal;
    varying vec3 vVertexWorldPosition;
    void main() {
      vec3 worldCameraToVertex = vVertexWorldPosition - cameraPosition;
      vec3 viewCameraToVertex = (viewMatrix * vec4(worldCameraToVertex, 0.0)).xyz;
      viewCameraToVertex = normalize(viewCameraToVertex);
      float intensity = pow(
        coefficient + dot(vVertexNormal, viewCameraToVertex),
        power
      );
      gl_FragColor = vec4(color, intensity);
    }
  `,
	});
}

/** 顶点沿法线外扩 size（BufferGeometry 版的 createGlowGeometry） */
function inflateGeometry(
	source: THREE.BufferGeometry,
	size: number,
): THREE.BufferGeometry {
	const clone = source.clone();
	const pos = clone.getAttribute("position") as THREE.BufferAttribute;
	const nor = clone.getAttribute("normal");
	if (nor && nor.count === pos.count) {
		for (let i = 0; i < pos.count; i++) {
			pos.setXYZ(
				i,
				pos.getX(i) + nor.getX(i) * size,
				pos.getY(i) + nor.getY(i) * size,
				pos.getZ(i) + nor.getZ(i) * size,
			);
		}
	} else {
		clone.computeVertexNormals();
		const n2 = clone.getAttribute("normal") as THREE.BufferAttribute;
		for (let i = 0; i < pos.count; i++) {
			pos.setXYZ(
				i,
				pos.getX(i) + n2.getX(i) * size,
				pos.getY(i) + n2.getY(i) * size,
				pos.getZ(i) + n2.getZ(i) * size,
			);
		}
	}
	pos.needsUpdate = true;
	return clone;
}

export function createGlowMesh(
	geometry: THREE.BufferGeometry,
	options?: Partial<GlowOptions>,
): THREE.Mesh {
	const o = { ...defaultGlowOptions, ...options };
	const mat = createGlowMaterial(o.coefficient, o.color, o.power);
	if (o.backside) mat.side = THREE.BackSide;
	const geo = inflateGeometry(geometry, o.size);
	return new THREE.Mesh(geo, mat);
}
