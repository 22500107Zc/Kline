import test from 'node:test';
import assert from 'node:assert/strict';
import { PhysicsWorld, createBody, defaultWorld } from '../src/physics/rigidbody';
import { bakeToKeyframes, clearBake, settle, worldFromScene } from '../src/physics/bake';
import { Scene, createPhysicsBody } from '../src/scene/Scene';
import { buildPrimitive } from '../src/mesh/primitives';
import { sampleChannels } from '../src/anim/animation';
import { Vec3 } from '../src/core/math';

function ground(): ReturnType<typeof createBody> {
  return createBody(0, {
    shape: 'box', halfExtents: new Vec3(20, 20, 0.5),
    position: new Vec3(0, 0, -0.5), mass: 0, restitution: 0.9,
  });
}

test('a body falls under gravity', () => {
  const w = new PhysicsWorld();
  const b = w.add(createBody(1, { position: new Vec3(0, 0, 10) }));
  for (let i = 0; i < 30; i++) w.step();
  assert.ok(b.position.z < 10, 'it did not fall');
  // Half a second of freefall from rest is about 1.2 metres.
  const dropped = 10 - b.position.z;
  assert.ok(dropped > 0.8 && dropped < 1.6, `fell ${dropped.toFixed(3)}m in half a second`);
});

test('a passive body never moves', () => {
  const w = new PhysicsWorld();
  const floor = w.add(ground());
  w.add(createBody(1, { position: new Vec3(0, 0, 3) }));
  for (let i = 0; i < 400; i++) w.step();
  assert.deepEqual(
    [floor.position.x, floor.position.y, floor.position.z],
    [0, 0, -0.5],
    'the floor moved',
  );
});

test('a box lands on the floor and stops there', () => {
  const w = new PhysicsWorld();
  w.add(ground());
  const box = w.add(createBody(1, {
    shape: 'box', halfExtents: new Vec3(0.5, 0.5, 0.5), position: new Vec3(0, 0, 5),
  }));
  for (let i = 0; i < 600; i++) w.step();
  // Resting on a floor whose top is at z = 0 puts its centre at 0.5.
  assert.ok(Math.abs(box.position.z - 0.5) < 0.05, `settled at z = ${box.position.z.toFixed(4)}`);
  assert.ok(box.velocity.length() < 0.1, `still moving at ${box.velocity.length().toFixed(4)}`);
  assert.ok(box.sleeping, 'a settled body should stop being simulated');
});

test('a stack of boxes holds still rather than sinking or jittering', () => {
  // The property iteration buys: a single resolution pass leaves this
  // shuffling for the whole bake.
  const w = new PhysicsWorld();
  w.add(ground());
  const boxes = [];
  for (let i = 0; i < 4; i++) {
    boxes.push(w.add(createBody(i + 1, {
      shape: 'box', halfExtents: new Vec3(0.5, 0.5, 0.5),
      position: new Vec3(0, 0, 0.5 + i * 1.02),
    })));
  }
  for (let i = 0; i < 900; i++) w.step();
  boxes.forEach((b, i) => {
    const want = 0.5 + i;
    assert.ok(
      Math.abs(b.position.z - want) < 0.12,
      `box ${i} settled at ${b.position.z.toFixed(3)}, wanted about ${want}`,
    );
  });
  // Nothing sank through anything.
  for (let i = 1; i < boxes.length; i++) {
    assert.ok(boxes[i].position.z > boxes[i - 1].position.z, 'the stack fell through itself');
  }
});

test('two spheres pushed together separate', () => {
  const w = new PhysicsWorld({ ...defaultWorld(), gravity: new Vec3() });
  const a = w.add(createBody(1, { shape: 'sphere', halfExtents: new Vec3(1, 0, 0), position: new Vec3(-0.4, 0, 0) }));
  const b = w.add(createBody(2, { shape: 'sphere', halfExtents: new Vec3(1, 0, 0), position: new Vec3(0.4, 0, 0) }));
  for (let i = 0; i < 200; i++) w.step();
  const gap = b.position.distanceTo(a.position);
  assert.ok(gap > 1.9, `they are still overlapping at ${gap.toFixed(3)}`);
});

test('a sphere rolls off nothing and rests on a box', () => {
  const w = new PhysicsWorld();
  w.add(ground());
  const ball = w.add(createBody(1, {
    shape: 'sphere', halfExtents: new Vec3(0.5, 0, 0), position: new Vec3(0, 0, 4),
  }));
  for (let i = 0; i < 600; i++) w.step();
  assert.ok(Math.abs(ball.position.z - 0.5) < 0.06, `settled at ${ball.position.z.toFixed(4)}`);
});

test('restitution decides how much a body bounces', () => {
  const drop = (restitution: number): number => {
    const w = new PhysicsWorld();
    w.add(ground());
    const b = w.add(createBody(1, { shape: 'sphere', halfExtents: new Vec3(0.5, 0, 0), position: new Vec3(0, 0, 4), restitution }));
    let peak = 0;
    let landed = false;
    for (let i = 0; i < 400; i++) {
      w.step();
      if (b.position.z < 0.6) landed = true;
      if (landed) peak = Math.max(peak, b.position.z);
    }
    return peak;
  };
  const dead = drop(0);
  const bouncy = drop(0.8);
  assert.ok(bouncy > dead + 0.3, `bouncy peaked at ${bouncy.toFixed(3)}, dead at ${dead.toFixed(3)}`);
});

test('a fixed timestep gives the same answer every run', () => {
  const run = (): number => {
    const w = new PhysicsWorld();
    w.add(ground());
    const b = w.add(createBody(1, { position: new Vec3(0.1, -0.2, 3), velocity: new Vec3(1, 0.5, 0) }));
    for (let i = 0; i < 300; i++) w.step();
    return b.position.x * 1e6 + b.position.y * 1e3 + b.position.z;
  };
  assert.equal(run(), run());
});

// ------------------------------------------------------------------- baking

function droppingScene(): Scene {
  const scene = new Scene();
  scene.timeline.start = 1;
  scene.timeline.end = 40;
  const floor = scene.add('mesh', 'Floor', buildPrimitive('cube'));
  floor.scale = new Vec3(10, 10, 0.1);
  floor.position = new Vec3(0, 0, -0.1);
  floor.physics = createPhysicsBody('passive');
  const box = scene.add('mesh', 'Box', buildPrimitive('cube'));
  box.position = new Vec3(0, 0, 6);
  box.physics = createPhysicsBody('active');
  return scene;
}

test('a scene turns into a world of bodies', () => {
  const scene = droppingScene();
  const w = worldFromScene(scene);
  assert.equal(w.bodies.length, 2);
  assert.equal(w.bodies.filter((b) => b.mass === 0).length, 1, 'the floor should be immovable');
});

test('objects without a body are not simulated', () => {
  const scene = droppingScene();
  scene.add('mesh', 'Bystander', buildPrimitive('uvsphere'));
  assert.equal(worldFromScene(scene).bodies.length, 2);
});

test('baking writes keyframes that show the object falling', () => {
  const scene = droppingScene();
  const box = [...scene.objects.values()].find((o) => o.name === 'Box')!;
  const result = bakeToKeyframes(scene);
  assert.equal(result.bodies, 1);
  assert.ok(result.keys > 0);
  assert.ok(box.animation.length > 0, 'no channels were written');

  const atStart = sampleChannels(box.animation, scene.timeline.start);
  const atEnd = sampleChannels(box.animation, scene.timeline.end);
  assert.ok(atStart.position, 'no position at the first frame');
  assert.ok(atEnd.position, 'no position at the last frame');
  assert.ok(atStart.position!.z > atEnd.position!.z + 1, 'the box did not fall over the bake');
  // And it landed rather than falling through: a 2-unit cube on a floor whose
  // top is at zero rests with its origin at 1.
  assert.ok(Math.abs(atEnd.position!.z - 1) < 0.3, `ended at z = ${atEnd.position!.z.toFixed(3)}`);
});

test('the floor is not keyframed', () => {
  const scene = droppingScene();
  bakeToKeyframes(scene);
  const floor = [...scene.objects.values()].find((o) => o.name === 'Floor')!;
  assert.equal(floor.animation.length, 0, 'a passive body should not be animated');
});

test('baking twice does not stack two takes on top of each other', () => {
  const scene = droppingScene();
  const box = [...scene.objects.values()].find((o) => o.name === 'Box')!;
  bakeToKeyframes(scene);
  const first = box.animation.map((c) => c.keys.length);
  bakeToKeyframes(scene);
  assert.deepEqual(box.animation.map((c) => c.keys.length), first, 'the second bake piled on');
});

test('an existing hand animation is replaced, not blended with', () => {
  const scene = droppingScene();
  const box = [...scene.objects.values()].find((o) => o.name === 'Box')!;
  box.animation = [{ path: 'position', index: 2, keys: [{ frame: 1, value: 99, interp: 'linear' }] }];
  bakeToKeyframes(scene);
  const at1 = sampleChannels(box.animation, 1);
  assert.ok(Math.abs(at1.position!.z - 99) > 1, 'the old key survived the bake');
});

test('clearing a bake removes what it wrote', () => {
  const scene = droppingScene();
  bakeToKeyframes(scene);
  assert.ok(clearBake(scene) > 0);
  for (const o of scene.objects.values()) {
    assert.equal(o.animation.filter((c) => c.path === 'position').length, 0);
  }
});

test('settling gives an answer without touching the scene', () => {
  const scene = droppingScene();
  const box = [...scene.objects.values()].find((o) => o.name === 'Box')!;
  const before = box.position.clone();
  const result = settle(scene, 4);
  assert.ok(result.get(box.id)!.position.z < 3, 'it did not settle');
  assert.equal(box.position.z, before.z, 'settling moved the scene object');
  assert.equal(box.animation.length, 0, 'settling wrote keyframes');
});

test('rigid body settings survive a save and load', () => {
  const scene = droppingScene();
  const back = Scene.fromJSON(JSON.parse(JSON.stringify(scene.toJSON())));
  const bodies = [...back.objects.values()].filter((o) => o.physics);
  assert.equal(bodies.length, 2);
  assert.ok(bodies.some((b) => b.physics!.kind === 'passive'));
  assert.ok(bodies.some((b) => b.physics!.kind === 'active'));
});
