// Flyets stilling. roll, pitch og yaw kommer fra HMI-en i grader.
import * as THREE from 'three';

// Innganger HMI-en kan koble tagger til. min/max setter bare området til testglidebryterne
// i kodeeditoren. smooth = sekunder for å gli over til en ny verdi; wrap: 360 får yaw
// til å ta den korte veien rundt (179° til -179° er 2°, ikke 358°).
const input = hmi.inputs({
  roll:  { value: 0, min: -90,  max: 90,  unit: '°', smooth: 0.25 },
  pitch: { value: 0, min: -90,  max: 90,  unit: '°', smooth: 0.25 },
  yaw:   { value: 0, min: -180, max: 180, unit: '°', smooth: 0.25, wrap: 360 },
});

// Scene, kamera, lys, bakkerutenett og render-løkke, tilpasset størrelsen på widgeten.
// controls: true lar deg rotere visningen med musen i Run-modus.
const { scene, onFrame } = hmi.stage({ camera: [4.5, 2.4, 5.5], grid: true, controls: true });

// ------------------------------------------------------------ flyet ditt, uendret

// 1. Bygg et flyhierarki med en Group
const airplane = new THREE.Group();

// Flykropp (langs Z, peker mot -Z)
const bodyGeo = new THREE.ConeGeometry(0.4, 3, 16);
bodyGeo.rotateX(-Math.PI / 2); // La kjeglespissen peke mot -Z
const bodyMat = new THREE.MeshStandardMaterial({ color: 0xcccccc });
const body = new THREE.Mesh(bodyGeo, bodyMat);
airplane.add(body);

// Vinger (strekker seg langs X)
const wingGeo = new THREE.BoxGeometry(4.2, 0.08, 0.8);
const wingMat = new THREE.MeshStandardMaterial({ color: 0x2266cc });
const wings = new THREE.Mesh(wingGeo, wingMat);
wings.position.set(0, 0, 0.2);
airplane.add(wings);

// Halefinne / sideror (peker langs +Y)
const rudderGeo = new THREE.BoxGeometry(0.08, 0.7, 0.5);
const rudderMat = new THREE.MeshStandardMaterial({ color: 0xcc2222 });
const rudder = new THREE.Mesh(rudderGeo, rudderMat);
rudder.position.set(0, 0.45, 1.1);
airplane.add(rudder);

// 2. Sett luftfartens rotasjonsrekkefølge: Yaw (Y) -> Pitch (X) -> Roll (Z)
airplane.rotation.order = 'YXZ';

// 3. Oppdater stillingsvinklene (radianer)
function setOrientation(pitch, yaw, roll) {
  airplane.rotation.x = pitch; // Pitch (rundt X)
  airplane.rotation.y = yaw;   // Yaw   (rundt Y)
  airplane.rotation.z = roll;  // Roll  (rundt Z)
}

// ------------------------------------------------------------

scene.add(airplane);

// Luftfartskonvensjon: positiv roll = høyre vinge ned, positiv yaw = nesen mot høyre,
// positiv pitch = nesen opp. Three.js dreier motsatt vei rundt Z og Y, derfor
// minustegnene på roll og yaw. Bruker sensoren din den andre konvensjonen, og
// flyet ruller eller svinger feil vei, fjerner du dem.
const rad = THREE.MathUtils.degToRad;
onFrame(() => setOrientation(rad(input.pitch), -rad(input.yaw), -rad(input.roll)));
