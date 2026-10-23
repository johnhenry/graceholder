// Health pack: CLEARLY FICTIONAL conditions and medications for demos and tests. Every condition and
// medication is an invented, whimsical name that is not a real diagnosis or drug, and by default the
// generators append "(fictional)" so a value can never be mistaken for medical data. Medical
// specialties are ordinary category names. Nothing here is medical information or advice.
// FROZEN at 1.0.0.

const freeze = (o) => {
  if (o !== null && typeof o === "object") for (const v of Object.values(o)) freeze(v);
  return Object.freeze(o);
};

// [condition, specialty, medication A, medication B]
const healthConditions = [
  ["Wibblefern Syndrome", "Neurology", "Glimmerol", "Wobblex"],
  ["Grumblecough", "Pulmonology", "Snoozeprax", "Puffadine"],
  ["Snorkelitis", "Otolaryngology", "Bubblenase", "Flumpazine"],
  ["Quibblepox", "Dermatology", "Dabbacream", "Spotless Plink"],
  ["Mumbleknee", "Orthopedics", "Creakaway", "Jointibop"],
  ["Flutterhiccup Disorder", "Gastroenterology", "Hiccuban", "Glugstop"],
  ["Marmalade Fever", "Infectious Disease", "Jamzolve", "Sticktoast"],
  ["Gigglepox", "Pediatrics", "Chuckleron", "Tickleflux"],
  ["Sillybone Disorder", "Rheumatology", "Funnymax", "Boneroo"],
  ["Twiddlethumb Palsy", "Neurology", "Fidgetol", "Thumbwell"],
  ["Noodleback", "Physical Medicine", "Stiffnot", "Wigglorin"],
  ["Dizzlewhirl", "Otolaryngology", "Spinabate", "Steadyfloop"],
  ["Pumpernickel Rash", "Dermatology", "Crumbicide", "Smoothaloo"],
  ["Hullabaloo Headache", "Neurology", "Quietane", "Hushabye Forte"],
  ["Gloomcloud Fatigue", "Psychiatry", "Sunbeamol", "Brightify"],
  ["Tumbleweed Cough", "Pulmonology", "Rollaway", "Breezeomin"],
  ["Fidgetwing Syndrome", "Cardiology", "Calmwing", "Steadybeat"],
  ["Plinkerton Allergy", "Allergy", "Sneezeless", "Pollenpuff"],
  ["Blinkblot Strain", "Ophthalmology", "Clearglance", "Eyebrite Mist"],
  ["Crumplekidney Ache", "Nephrology", "Flushwell", "Filterfun"],
  ["Hiccup-in-the-Heart", "Cardiology", "Thumpaway", "Rhythmoo"],
  ["Mossback Stiffness", "Rheumatology", "Limberol", "Unkinkazine"],
  ["Pillowcase Insomnia", "Sleep Medicine", "Drowsabell", "Dreamlux"],
  ["Teacup Tremor", "Neurology", "Steadysip", "Shakeaway"],
];

const healthDoses = ["5 mg", "10 mg", "20 mg", "25 mg", "50 mg", "100 mg", "250 mg", "500 mg", "2 mL", "5 mL"];
const healthSeverities = ["mild", "moderate", "severe"];

export const health = freeze({
  name: "health",
  version: 1,
  vocab: { healthConditions, healthDoses, healthSeverities },
  rules({ tokens, last, kind }) {
    const key = tokens.join(" ");
    if (last === "diagnosis" || last === "illness" || last === "disease" || (last === "condition" && kind !== "product")) return { sdl: "String", gen: "health.condition" };
    if (last === "medication" || last === "drug" || last === "medicine" || last === "prescription") return { sdl: "String", gen: "health.medication" };
    if (last === "dosage" || last === "dose") return { sdl: "String", gen: "health.dosage" };
    if (last === "specialty" || last === "speciality") return { sdl: "String", gen: "health.specialty" };
    if (key === "severity" || key === "condition severity") return { sdl: "String", gen: "health.severity" };
    if (key === "mrn" || key === "record number" || key === "medical record number") return { sdl: "String", gen: "health.recordNumber" };
    return null;
  },
  generators(V) {
    // one "condition" slot per entity: condition, medication and specialty agree
    const row = (ctx) => ctx.slot("condition").pick(V.healthConditions);
    const tag = (text, args) => (args.tag === false ? text : `${text} (fictional)`);
    return {
      "health.condition": (ctx) => tag(row(ctx)[0], ctx.args),
      "health.medication": (ctx) => {
        const r = row(ctx);
        return tag(r[2 + ctx.slot("medChoice").int(0, 1)], ctx.args);
      },
      "health.dosage": (ctx) => ctx.slot("dose").pick(V.healthDoses),
      "health.specialty": (ctx) => row(ctx)[1],
      "health.severity": (ctx) => ctx.slot("severity").pick(V.healthSeverities),
      // not a real identifier format: the FX prefix marks it as fictional
      "health.recordNumber": (ctx) => `FX-${String(ctx.slot("mrn").int(0, 9999999)).padStart(7, "0")}`,
    };
  },
});

export default health;
