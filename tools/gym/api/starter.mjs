// The starter program a person can load with one tap (POST /starter) on an empty account:
// two full-body sessions built to be kind to shoulders and the lower back, a 10-minute
// mobility routine, a Mon/Wed/Fri plan alternating A and B, and those two areas to rate.
// Exercises are named by key here; the API gives each its own id when it loads them.
//   measure: 'reps' (weight × reps), 'time' (seconds), 'distance' (meters); weight is optional for all
export const EXERCISES = {
  trapbar: { name: 'Trap bar deadlift', measure: 'reps', note: 'High handles at first. Push the floor away; hips and shoulders rise together.' },
  landmine: { name: 'Half-kneeling landmine press', measure: 'reps', perSide: true, note: 'Ribs down, squeeze the down-knee glute. Press up and forward, not overhead.' },
  csrow: { name: 'Chest-supported row', measure: 'reps', note: 'Machine or incline bench. Pull elbows to back pockets; pause at the top.' },
  goblet: { name: 'Goblet squat to a box', measure: 'reps', note: 'Sit back to the box with control; stand without rocking.' },
  facepull: { name: 'Cable face pull', measure: 'reps', note: 'Rope at eye height; pull to the forehead, thumbs back.' },
  suitcase: { name: 'Suitcase carry', measure: 'distance', perSide: true, note: 'One weight, stand tall, don’t lean toward or away from it.' },
  pallof: { name: 'Pallof press', measure: 'reps', perSide: true, note: 'Press out and hold a breath; don’t let the cable turn you.' },
  deadbug: { name: 'Dead bug', measure: 'reps', perSide: true, note: 'Low back stays on the floor. Slow.' },
  legpress: { name: 'Leg press', measure: 'reps', note: 'Feet mid-platform; stop before the low back peels off the pad.' },
  pulldown: { name: 'Lat pulldown, neutral grip', measure: 'reps', note: 'Chest up, pull to the collarbone.' },
  backext: { name: '45° back extension', measure: 'reps', note: 'Hips over the pad. Rise to a straight line, no further.' },
  pushup: { name: 'Push-up', measure: 'reps', note: 'Hands raised on a bench if needed. Body in one line.' },
  carow: { name: 'Single-arm cable row', measure: 'reps', perSide: true, note: 'Let the shoulder blade move; don’t twist.' },
  extrot: { name: 'Cable external rotation', measure: 'reps', perSide: true, note: 'Elbow pinned to your side; light weight, slow.' },
  sideplank: { name: 'Side plank', measure: 'time', perSide: true, note: 'Hips high; a straight line head to feet.' },
  stirpot: { name: 'Stir-the-pot', measure: 'reps', note: 'Forearms on a ball, small circles each way; hips still.' },
  openbook: { name: 'Open books', measure: 'reps', perSide: true, note: 'Upper-back rotation, so the low back doesn’t have to.' },
  couch: { name: 'Couch stretch', measure: 'time', perSide: true, note: 'Hip flexors. Squeeze the glute; ribs down.' },
  ninety: { name: '90/90 hip switches', measure: 'reps', perSide: true, note: 'Hip rotation. Hands behind you if needed.' },
  childs: { name: 'Child’s pose, hands to each side', measure: 'time', perSide: true, note: 'Lats and upper back.' },
  doorway: { name: 'Doorway pec stretch', measure: 'time', perSide: true, note: 'Elbow at shoulder height; step through gently.' },
  cars: { name: 'Shoulder CARs', measure: 'reps', perSide: true, note: 'Slow, biggest circle you can control; the rest of you stays still.' },
  hang: { name: 'Dead hang', measure: 'time', note: 'Feet touching if needed. Skip it if it pinches.' },
};

// Items: [exercise, sets, target, pair, rest seconds]. Items sharing a pair alternate;
// the short rest after the first of a pair is the walk to the second.
const item = ([ex, sets, target, pair, rest]) => ({ ex, sets, target, pair, rest });
export const WORKOUTS = [
  {
    key: 'a', name: 'Session A', note: 'Warm-up: cat–cow ×8, bird dog ×6/side, band pull-aparts ×15, wall slides ×10, squats ×10.',
    items: [
      ['trapbar', 3, '6–8', 1, 15], ['landmine', 3, '8', 1, 60],
      ['csrow', 3, '10', 2, 15], ['goblet', 3, '10', 2, 60],
      ['facepull', 3, '12–15', 3, 15], ['suitcase', 3, '30 m', 3, 60],
      ['pallof', 2, '10', 4, 0], ['deadbug', 2, '8', 4, 30],
    ].map(item),
  },
  {
    key: 'b', name: 'Session B', note: 'Warm-up: cat–cow ×8, bird dog ×6/side, band pull-aparts ×15, wall slides ×10, squats ×10.',
    items: [
      ['legpress', 3, '8–10', 1, 15], ['pulldown', 3, '10', 1, 60],
      ['backext', 3, '10–12', 2, 15], ['pushup', 3, '8–12', 2, 60],
      ['carow', 3, '10', 3, 15], ['extrot', 2, '12–15', 3, 60],
      ['sideplank', 2, '20–40 s', 4, 0], ['stirpot', 2, '6 each way', 4, 30],
    ].map(item),
  },
  {
    key: 'm', name: 'Mobility', note: 'About 10 minutes, after a session or on its own. Short on time: open books, couch stretch, doorway.',
    items: [
      ['openbook', 1, '8', 0, 0], ['couch', 1, '60 s', 0, 0], ['ninety', 1, '8', 0, 0],
      ['childs', 1, '30 s', 0, 0], ['doorway', 1, '30 s', 0, 0], ['cars', 1, '3', 0, 0], ['hang', 3, '15–30 s', 0, 30],
    ].map(item),
  },
];

export const PLAN = { rotation: ['a', 'b'], days: [1, 3, 5], perWeek: 3 };
export const SETTINGS = { unit: 'lb', areas: ['Shoulders', 'Lower back'] };
