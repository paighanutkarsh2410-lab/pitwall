import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";

/**
 * The studio: a black room lit like the opening titles. Long softbox strips (white overhead and
 * at the sides, red behind) are rendered into an environment map, so the car's bodywork carries
 * long, clean strip reflections, which is most of what makes a car render look real.
 */
export interface Stage {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  composer: EffectComposer;
  bloom: UnrealBloomPass;
  rim: THREE.SpotLight;
  backdrop: THREE.Mesh;
  /** Re-grades the studio for a team: the coloured strip in the reflections, the backdrop glow
   * and the rim light. Rebuilding the environment takes a few milliseconds. */
  setAccent: (glow: number, rim: number) => void;
  resize: () => void;
  render: () => void;
}

function studioEnvironment(renderer: THREE.WebGLRenderer, accent = 0xff1a0a): THREE.Texture {
  const room = new THREE.Scene();
  room.background = new THREE.Color(0x030304);
  const strip = (w: number, h: number, colour: number, power: number, at: [number, number, number], face: [number, number, number]) => {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(colour).multiplyScalar(power), side: THREE.DoubleSide }),
    );
    mesh.position.set(...at);
    mesh.lookAt(...face);
    room.add(mesh);
  };
  strip(9, 1.6, 0xffffff, 7, [0, 7, 0], [0, 0, 0]); // the overhead softbox
  strip(0.5, 7, 0xffffff, 3.5, [-8, 2.5, 2], [0, 1, 0]); // a tall strip, camera-left
  strip(0.5, 7, 0xffffff, 2, [8, 2.5, -1], [0, 1, 0]); // a dimmer one, camera-right
  strip(12, 1, accent, 2.5, [0, 1.5, -9], [0, 1, 0]); // the team's colour, a line behind
  strip(8, 0.4, 0xffffff, 1.5, [0, 0.6, 9], [0, 0.6, 0]); // a low kicker in front
  const pmrem = new THREE.PMREMGenerator(renderer);
  const texture = pmrem.fromScene(room, 0.03).texture;
  pmrem.dispose();
  return texture;
}

function radialTexture(stops: [number, string][]): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 512;
  const g = canvas.getContext("2d")!;
  const grad = g.createRadialGradient(256, 256, 0, 256, 256, 256);
  for (const [at, colour] of stops) grad.addColorStop(at, colour);
  g.fillStyle = grad;
  g.fillRect(0, 0, 512, 512);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function createStage(canvas: HTMLCanvasElement): Stage {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x070708);
  scene.environment = studioEnvironment(renderer);
  scene.environmentIntensity = 1.5;

  // A long lens: flatter perspective, the way car commercials are shot.
  const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 200);

  // The cyclorama: a red glow on the back wall, falling to black.
  const backdrop = new THREE.Mesh(
    new THREE.PlaneGeometry(34, 18),
    new THREE.MeshBasicMaterial({
      // A neutral glow, tinted by the material's colour: the team's (setAccent).
      map: radialTexture([[0, "rgba(255,255,255,0.55)"], [0.4, "rgba(150,150,150,0.22)"], [1, "rgba(0,0,0,0)"]]),
      color: 0xc80600,
      transparent: true,
      depthWrite: false,
    }),
  );
  backdrop.position.set(7, 3.2, -16);
  scene.add(backdrop);

  // The floor: dark and glossy, fading out to the room.
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(30, 64),
    new THREE.MeshStandardMaterial({
      color: 0x0c0c0e,
      roughness: 0.46,
      metalness: 0.0,
      alphaMap: radialTexture([[0, "#fff"], [0.55, "#888"], [1, "#000"]]),
      transparent: true,
    }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  // Key light from above and in front; a red rim from behind; a cold fill from the left.
  const key = new THREE.DirectionalLight(0xffffff, 3.2);
  key.position.set(-3, 9, 6);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -8;
  key.shadow.camera.right = 8;
  key.shadow.camera.top = 6;
  key.shadow.camera.bottom = -6;
  key.shadow.bias = -0.0004;
  key.shadow.radius = 6;
  scene.add(key);
  const rim = new THREE.SpotLight(0xff2a14, 30, 30, Math.PI / 6, 0.7, 1.6);
  rim.position.set(6, 3.5, -6);
  rim.target.position.set(1, 0.5, 0);
  scene.add(rim, rim.target);
  const fill = new THREE.DirectionalLight(0xbcd2ff, 0.5);
  fill.position.set(-8, 2, 2);
  scene.add(fill);

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.3, 0.5, 0.92);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  const resize = () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    bloom.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  resize();

  const setAccent = (glow: number, rimColour: number) => {
    const old = scene.environment;
    scene.environment = studioEnvironment(renderer, glow);
    old?.dispose();
    (backdrop.material as THREE.MeshBasicMaterial).color.setHex(glow);
    rim.color.setHex(rimColour);
  };

  return { renderer, scene, camera, composer, bloom, rim, backdrop, setAccent, resize, render: () => composer.render() };
}
