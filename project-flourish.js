import * as THREE from "three";

// Small-scale version of the faceted globe and drawn orbit in the ESPL
// research-flourish reference. It renders only while its hover/focus motion runs.
const link = document.getElementById("projectLink");
const canvas = document.getElementById("projectFlourishCanvas");
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

if (link && canvas) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 20);
  camera.position.set(0, 0, 4.3);
  camera.lookAt(0, 0, 0);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(58, 58, false);
  renderer.setClearColor(0x000000, 0);

  scene.add(new THREE.AmbientLight(0xffffff, 0.72));
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.15);
  keyLight.position.set(1.35, 1.65, 2.4);
  scene.add(keyLight);
  const fillLight = new THREE.DirectionalLight(0xffe7a3, 0.16);
  fillLight.position.set(-1.35, -0.7, 1.35);
  scene.add(fillLight);

  const globe = new THREE.Mesh(
    new THREE.IcosahedronGeometry(1, 1),
    new THREE.MeshStandardMaterial({
      color: 0xffd400,
      emissive: 0xffca00,
      emissiveIntensity: 0.18,
      flatShading: true,
      roughness: 0.76,
      metalness: 0.08
    })
  );
  globe.rotation.set(0.45, 0.65, 0);
  scene.add(globe);

  const orbitRoot = new THREE.Group();
  orbitRoot.rotation.set(
    THREE.MathUtils.degToRad(29),
    THREE.MathUtils.degToRad(-15),
    THREE.MathUtils.degToRad(-14)
  );
  scene.add(orbitRoot);

  const segmentCount = 360;
  const orbitPoints = [];
  const xAxis = new THREE.Vector3(1, 0, 0);
  const yAxis = new THREE.Vector3(0, 1, 0);

  for (let index = 0; index <= segmentCount; index += 1) {
    const angle = (index / segmentCount) * Math.PI * 2;
    const point = new THREE.Vector3(
      Math.cos(angle) * 1.28,
      Math.sin(angle) * 1.28,
      0
    );
    point.applyAxisAngle(xAxis, THREE.MathUtils.degToRad(64));
    point.applyAxisAngle(yAxis, THREE.MathUtils.degToRad(-22));
    orbitPoints.push(point);
  }

  // A tube keeps the orbit one continuous, consistently thick black stroke.
  // WebGL lineWidth is ignored by most browsers.
  const orbitGeometry = new THREE.TubeGeometry(
    new THREE.CatmullRomCurve3(orbitPoints),
    segmentCount,
    0.024,
    6,
    false
  );
  const orbit = new THREE.Mesh(
    orbitGeometry,
    new THREE.MeshBasicMaterial({ color: 0x000000, depthWrite: false })
  );
  orbitRoot.add(orbit);

  function setOrbitProgress(progress) {
    const count = Math.floor(segmentCount * Math.max(0, Math.min(1, progress)));
    orbitGeometry.setDrawRange(0, count * 6 * 6);
  }

  function render() {
    renderer.render(scene, camera);
  }

  setOrbitProgress(0);
  render();

  let frame = 0;
  let animation = null;
  let open = false;
  let orbitProgress = 0;
  const restingRotation = globe.rotation.y;

  function ease(t) {
    return t * t * (3 - 2 * t);
  }

  function animate(now) {
    if (!animation) return;
    const t = Math.min(1, (now - animation.start) / animation.duration);
    const eased = ease(t);
    globe.rotation.y = animation.fromRotation
      + (animation.toRotation - animation.fromRotation) * eased;
    orbitProgress = animation.fromOrbit
      + (animation.toOrbit - animation.fromOrbit) * eased;
    setOrbitProgress(orbitProgress);
    render();

    if (t < 1) {
      frame = requestAnimationFrame(animate);
    } else {
      orbitProgress = animation.toOrbit;
      animation = null;
      setOrbitProgress(orbitProgress);
      render();
    }
  }

  function startMotion(closing) {
    cancelAnimationFrame(frame);
    if (reducedMotion.matches) {
      globe.rotation.y = restingRotation + (closing ? 0 : 1.05);
      orbitProgress = closing ? 0 : 1;
      setOrbitProgress(orbitProgress);
      render();
      return;
    }
    animation = {
      start: performance.now(),
      duration: closing ? 800 : 1000,
      fromRotation: globe.rotation.y,
      toRotation: restingRotation + (closing ? 0 : 1.05),
      fromOrbit: orbitProgress,
      toOrbit: closing ? 0 : 1
    };
    frame = requestAnimationFrame(animate);
  }

  function closeFlourish() {
    if (!open) return;
    open = false;
    link.classList.remove("is-open");
    startMotion(true);
  }

  function openFlourish() {
    if (open) return;
    open = true;
    link.classList.add("is-open");
    startMotion(false);
  }

  link.addEventListener("pointerenter", openFlourish);
  link.addEventListener("pointerleave", closeFlourish);
  link.addEventListener("focus", openFlourish);
  link.addEventListener("blur", closeFlourish);
}
