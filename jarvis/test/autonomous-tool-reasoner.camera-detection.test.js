import test from 'node:test';
import assert from 'node:assert/strict';
import { AutonomousToolReasoner } from '../src/autonomous-tool-reasoner.js';

const reasoner = new AutonomousToolReasoner();

const cameraStartCases = ['open camera', 'open the camera', 'start camera', 'turn on my camera', 'turn on the camera'];
for (const query of cameraStartCases) {
  test(`classifies "${query}" as CAMERA_START`, () => {
    const decision = reasoner.evaluateIntent(query);
    assert.equal(decision.toolName, 'CAMERA_START');
  });
}

const cameraStopCases = ['close camera', 'close the camera', 'stop camera', 'turn off my camera', 'turn off the camera'];
for (const query of cameraStopCases) {
  test(`classifies "${query}" as CAMERA_STOP`, () => {
    const decision = reasoner.evaluateIntent(query);
    assert.equal(decision.toolName, 'CAMERA_STOP');
  });
}

const nonCameraQueries = [
  'what is the capital of France',
  'play Cyberpunk 2077',
  'switch mode to high',
  'open spotify',
  'open steam',
  'start monitoring my screen'
];
for (const query of nonCameraQueries) {
  test(`does not classify "${query}" as a camera command`, () => {
    const decision = reasoner.evaluateIntent(query);
    assert.notEqual(decision.toolName, 'CAMERA_START');
    assert.notEqual(decision.toolName, 'CAMERA_STOP');
  });
}
