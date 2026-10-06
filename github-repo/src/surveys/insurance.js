// Insurance survey — Life (PRULife, Prudential Life Assurance Kenya).
//
// Unlike GT/MT this survey is completed by the PROPOSER (the potential
// client) themselves, not by a field agent — so it is a "publicAccess"
// track: nobody registers as an agent first. Phase 1 is data collection
// only; the quote is prepared and shared offline, and a completion alert
// goes to the team (see src/alerts.js). Phase 2 will replace the offline
// quote with a call to the Prudential API — only the quote step changes,
// the questions and rules below stay the same.
//
// Product rules come from the PRULife brochure plus the business decisions
// below. Every number lives in one place (the constants right here) so a
// rule change is a one-line edit.
//
// Business decisions (Oct 2026):
//  - medical-free cover limit is KES 15M per POLICY (was 8.5M in the brochure)
//  - maximum sum assured KES 150M; above that needs special clearance
//    (accepted and flagged, not rejected)
//  - minimum premium KES 3,000 per MONTH (scaled for other frequencies)
//  - premium-mode amounts INCLUDE riders
//  - critical illness is available on Plan A as a rider and is built in
//    on Plan B; hospital cash is out of scope
//  - exact date of birth is collected (not age), plus gender

const ORG_NAME = process.env.INSURANCE_ORG_NAME || "Beamap";

// ---------------------------------------------------------------- rules
const MIN_AGE = 18;
const MAX_AGE = 60;
const TO60_MAX_ENTRY_AGE = 55; // "pay to age 60" needs entry at 55 or younger
const ACCIDENT_MAX_AGE = 59; // accident benefit issued between 18 and 59

const MIN_SA = 1_000_000;
const MAX_SA = 150_000_000;
const MEDICAL_FREE_LIMIT = 15_000_000;
const SA_SANITY_CEILING = 10_000_000_000; // typo guard only, not a product rule

const CI_MIN = 1_000_000;
const CI_MAX = 15_000_000;
const CI_PCT_OF_SA = 0.5; // CI rider can't exceed 50% of main SA
const CI_RIDER_MIN_SA = CI_MIN / CI_PCT_OF_SA; // 2,000,000: smallest SA that allows a 1M CI rider
const PLAN_B_CI_PCT = 0.5; // Plan B pays 50% of SA on first diagnosis...
const PLAN_B_CI_MAX = 15_000_000; // ...capped here (so SA above 30M is capped)

const ACC_MIN = 1_000_000;
const ACC_MAX = 20_000_000;
const ACC_PCT_OF_SA = 1.0; // accident rider can't exceed 100% of main SA

const MIN_MONTHLY_PREMIUM = 3000;
const TAX_RELIEF_RATE = 0.15;
const TAX_RELIEF_CAP = 60_000;

const FREQUENCIES = {
  Monthly: { perYear: 12, months: 1 },
  Quarterly: { perYear: 4, months: 3 },
  "Half-yearly": { perYear: 2, months: 6 },
  Yearly: { perYear: 1, months: 12 },
};

const kes = (n) => `KES ${Number(n).toLocaleString("en-US")}`;
const minPremiumFor = (freq) => MIN_MONTHLY_PREMIUM * (FREQUENCIES[freq]?.months || 1);

// ------------------------------------------------------------ age helpers
// "Today" is Nairobi's date (UTC+3), so a survey done late at night doesn't
// land on the wrong side of a birthday.
function nairobiToday(now = new Date()) {
  const d = new Date(now.getTime() + 3 * 3600 * 1000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

function ageOn(dobIso, today = nairobiToday()) {
  if (!dobIso) return null;
  const [y, m, d] = dobIso.split("-").map(Number);
  let age = today.y - y;
  if (today.m < m || (today.m === m && today.d < d)) age -= 1;
  return age;
}

function daysToNextBirthday(dobIso, today = nairobiToday()) {
  const [, m, d] = dobIso.split("-").map(Number);
  const todayUtc = Date.UTC(today.y, today.m - 1, today.d);
  let next = Date.UTC(today.y, m - 1, d);
  if (next < todayUtc) next = Date.UTC(today.y + 1, m - 1, d);
  return Math.round((next - todayUtc) / 86400000);
}

const formatDob = (iso) => {
  if (!iso) return "";
  const [y, m, d] = String(iso).split("-");
  return `${d}/${m}/${y}`;
};

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const longDate = (iso) => {
  const [y, m, d] = String(iso).split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
};
const bigAmountNote = (v) =>
  v >= MEDICAL_FREE_LIMIT ? " — that's a large amount, so please check the number of zeros (type EDIT if it's not right)" : "";

const mainAge = (a) => ageOn(a.dateOfBirth);
const spouseAge = (a) => (a.coverType === "Joint Life" && a.spouseDob ? ageOn(a.spouseDob) : null);
const isJoint = (a) => a.coverType === "Joint Life";

// ------------------------------------------------------- derived options
function termOptions(a) {
  const ages = [mainAge(a)];
  if (isJoint(a) && a.spouseDob) ages.push(spouseAge(a));
  const to60Ok = ages.every((x) => x !== null && x !== undefined && x <= TO60_MAX_ENTRY_AGE);
  return ["Whole Life", "To age 65", ...(to60Ok ? ["To age 60"] : []), "10 Years", "15 Years", "20 Years"];
}

function accidentEligible(a) {
  const ages = [mainAge(a)];
  if (isJoint(a) && a.spouseDob) ages.push(spouseAge(a));
  return ages.every((x) => x !== null && x !== undefined && x <= ACCIDENT_MAX_AGE);
}

const saMode = (a) => a.calcMode === "Sum Assured";
const premiumMode = (a) => a.calcMode === "Premium";
const ciCap = (a) => Math.min(CI_MAX, Math.floor(a.sumAssured * CI_PCT_OF_SA));
const accCap = (a) => Math.min(ACC_MAX, Math.floor(a.sumAssured * ACC_PCT_OF_SA));

const numberedList = (opts) => opts.map((o, i) => `${i + 1}. ${o}`).join("\n");

// ----------------------------------------------------------------- steps
const SURVEY_STEPS = [
  {
    key: "consent",
    label: "Consent",
    type: "select",
    required: true,
    options: ["Yes, I agree", "No"],
    prompt:
      "👋 Welcome! This short survey collects the details we need to prepare your *PRULife* quote (Prudential whole-life cover). It takes about 3 minutes.\n\n" +
      "We'll ask for your name, date of birth, gender and whether you smoke. Some of this is personal and health-related information. " +
      `${ORG_NAME} will use it only to prepare and share your quote, and will keep it confidential.\n\n` +
      "Do you agree to us collecting and storing these details?\n1. Yes, I agree\n2. No",
    onAnswer: (value, answers) => {
      answers.consentAt = new Date().toISOString();
    },
    endIf: (value) =>
      value === "No"
        ? {
            save: false,
            message:
              "No problem — we haven't saved anything. If you change your mind, just send any message to start again. Thank you for your time.",
          }
        : null,
  },
  {
    key: "fullName",
    label: "Full Name",
    type: "text",
    required: true,
    prompt: "What is your *full name*?",
    opts: { min: 2, max: 60 },
  },
  {
    key: "email",
    label: "Email",
    type: "email",
    required: false,
    prompt: "What is your *email address*? We can send your quote there too. (Type SKIP if you'd rather not say.)",
  },
  {
    key: "dateOfBirth",
    label: "Date of Birth",
    type: "date",
    required: true,
    prompt: "What is your *date of birth*? Please use DD/MM/YYYY, for example 15/03/1985.",
    format: formatDob,
    echo: (v) => `${longDate(v)} (age ${ageOn(v)})`,
    endIf: (value) => {
      const age = ageOn(value);
      if (age < MIN_AGE || age > MAX_AGE) {
        return {
          save: true,
          status: "INELIGIBLE",
          message:
            `Thank you. PRULife cover is available to people aged ${MIN_AGE} to ${MAX_AGE}, so we're unable to offer it for the date of birth you gave. ` +
            "If you entered it by mistake, type START to begin again.",
        };
      }
      return null;
    },
  },
  {
    key: "gender",
    label: "Gender",
    type: "select",
    required: true,
    options: ["Male", "Female"],
    prompt: "What is your *gender*?\n1. Male\n2. Female",
  },
  {
    key: "smoker",
    label: "Smoker",
    type: "select",
    required: true,
    options: ["Yes", "No"],
    prompt: "Do you currently *smoke*? (Smoking status affects the premium.)\n1. Yes\n2. No",
  },
  {
    key: "coverType",
    label: "Cover Type",
    type: "select",
    required: true,
    options: ["Single Life", "Joint Life"],
    prompt:
      "Is this cover just for you, or for you *and your spouse*? Joint cover is offered at a discount.\n1. Single Life (just me)\n2. Joint Life (me and my spouse)",
  },
  {
    key: "spouseDob",
    label: "Spouse Date of Birth",
    type: "date",
    required: true,
    prompt: "What is your *spouse's date of birth*? (DD/MM/YYYY)",
    skipIf: (a) => !isJoint(a),
    format: formatDob,
    echo: (v) => `${longDate(v)} (age ${ageOn(v)})`,
    postValidate: (value) => {
      const age = ageOn(value);
      if (age < MIN_AGE || age > MAX_AGE) {
        return {
          ok: false,
          error:
            `Joint cover needs both people to be aged ${MIN_AGE} to ${MAX_AGE}. ` +
            "Enter a different date if that was a mistake, or type BACK and choose Single Life.",
        };
      }
      return { ok: true };
    },
  },
  {
    key: "spouseGender",
    label: "Spouse Gender",
    type: "select",
    required: true,
    options: ["Male", "Female"],
    prompt: "What is your *spouse's gender*?\n1. Male\n2. Female",
    skipIf: (a) => !isJoint(a),
  },
  {
    key: "spouseSmoker",
    label: "Spouse Smoker",
    type: "select",
    required: true,
    options: ["Yes", "No"],
    prompt: "Does your *spouse smoke*?\n1. Yes\n2. No",
    skipIf: (a) => !isJoint(a),
  },
  {
    key: "plan",
    label: "Plan",
    type: "select",
    required: true,
    options: ["Plan A", "Plan B"],
    prompt:
      "Which plan would you like?\n" +
      "1. *Plan A* – Whole Life Cover. Pays 100% of your cover plus bonuses on death. Critical illness cover can be added.\n" +
      "2. *Plan B* – Whole Life with Accelerated Critical Illness. Pays 50% of your cover on first diagnosis of a listed critical illness (up to KES 15,000,000) and waives future premiums; the rest is paid on death.",
  },
  {
    key: "premiumTerm",
    label: "Premium Payment Term",
    type: "select",
    required: true,
    promptBuilder: (a) => {
      const options = termOptions(a);
      return {
        options,
        prompt: `For how long would you like to *pay premiums*?\n${numberedList(options)}`,
      };
    },
  },
  {
    key: "calcMode",
    label: "Quote Based On",
    type: "select",
    required: true,
    options: ["Premium", "Sum Assured"],
    prompt:
      "How should we work out your quote?\n1. From the *premium* I want to pay\n2. From the *cover amount* I want",
  },
  {
    key: "paymentFrequency",
    label: "Payment Frequency",
    type: "select",
    required: true,
    options: Object.keys(FREQUENCIES),
    prompt: `How often would you like to pay?\n${numberedList(Object.keys(FREQUENCIES))}`,
  },
  {
    key: "modalPremium",
    label: "Premium Amount",
    type: "numeric",
    required: true,
    opts: { min: 0, max: 5_000_000, allowZero: false },
    skipIf: (a) => !premiumMode(a),
    promptBuilder: (a) => ({
      options: undefined,
      prompt:
        `How much would you like to pay *${String(a.paymentFrequency || "each period").toLowerCase()}* (in KES)? ` +
        "Enter the total including any extra benefits you may add.\n" +
        `The minimum is ${kes(minPremiumFor(a.paymentFrequency))}.`,
    }),
    format: (v) => kes(v),
    echo: (v, a) => `${kes(v)} ${String(a.paymentFrequency).toLowerCase()}`,
    postValidate: (value, a) => {
      const min = minPremiumFor(a.paymentFrequency);
      if (value < min) {
        return {
          ok: false,
          error:
            a.paymentFrequency === "Monthly"
              ? `The minimum premium is ${kes(min)} a month. Please enter ${kes(min)} or more.`
              : `The minimum premium for ${String(a.paymentFrequency).toLowerCase()} payments is ${kes(min)} (KES 3,000 a month). Please enter ${kes(min)} or more.`,
        };
      }
      return { ok: true };
    },
  },
  {
    key: "sumAssured",
    label: "Cover Amount",
    type: "money",
    required: true,
    opts: { min: MIN_SA, max: SA_SANITY_CEILING },
    skipIf: (a) => !saMode(a),
    prompt:
      "How much *cover* would you like? You can type it like 5m, 5 million or 5,000,000.\n" +
      `Cover starts at ${kes(MIN_SA)}. Amounts above ${kes(MEDICAL_FREE_LIMIT)} need a medical examination, and above ${kes(MAX_SA)} need special approval.`,
    format: (v) => kes(v),
    echo: (v) => `${kes(v)}${bigAmountNote(v)}`,
  },
  {
    key: "ciRider",
    label: "Add Critical Illness Cover",
    type: "select",
    required: true,
    options: ["Yes", "No"],
    skipIf: (a) => a.plan === "Plan B" || (saMode(a) && (a.sumAssured === undefined || a.sumAssured < CI_RIDER_MIN_SA)),
    prompt:
      "Would you like to add *Critical Illness* cover? It pays an extra amount on first diagnosis of a listed critical illness before age 65.\n1. Yes\n2. No",
  },
  {
    key: "ciAmount",
    label: "Critical Illness Cover Amount",
    type: "money",
    required: true,
    opts: { min: CI_MIN, max: SA_SANITY_CEILING, allowKeywords: ["MAX"] },
    skipIf: (a) => a.plan === "Plan B" || a.ciRider !== "Yes" || !saMode(a),
    promptBuilder: (a) => ({
      options: undefined,
      prompt:
        `How much extra critical illness cover would you like? Between ${kes(CI_MIN)} and ${kes(ciCap(a))} ` +
        `(no more than half of your ${kes(a.sumAssured)} main cover). Type an amount like 2.5m, or MAX for the highest allowed.`,
    }),
    format: (v) => kes(v),
    echo: (v) => kes(v),
    postValidate: (value, a) => {
      const cap = ciCap(a);
      if (value === "MAX") return { ok: true, value: cap };
      if (value > cap) {
        return {
          ok: false,
          error: `Critical illness cover can't be more than half your main cover (${kes(cap)}). Please enter ${kes(cap)} or less, or type MAX.`,
        };
      }
      return { ok: true };
    },
  },
  {
    key: "accidentRider",
    label: "Add Accident Cover",
    type: "select",
    required: true,
    options: ["Yes", "No"],
    skipIf: (a) => !accidentEligible(a),
    prompt:
      "Would you like to add *Accident* cover? It pays an extra amount on accidental death or total and permanent disability before age 65.\n1. Yes\n2. No",
  },
  {
    key: "accidentAmount",
    label: "Accident Cover Amount",
    type: "money",
    required: true,
    opts: { min: ACC_MIN, max: SA_SANITY_CEILING, allowKeywords: ["MAX"] },
    skipIf: (a) => !accidentEligible(a) || a.accidentRider !== "Yes" || !saMode(a),
    promptBuilder: (a) => ({
      options: undefined,
      prompt:
        `How much extra accident cover would you like? Between ${kes(ACC_MIN)} and ${kes(accCap(a))} ` +
        `(no more than your ${kes(a.sumAssured)} main cover). Type an amount like 5m, or MAX for the highest allowed.`,
    }),
    format: (v) => kes(v),
    echo: (v) => kes(v),
    postValidate: (value, a) => {
      const cap = accCap(a);
      if (value === "MAX") return { ok: true, value: cap };
      if (value > cap) {
        return {
          ok: false,
          error: `Accident cover can't be more than your main cover (${kes(cap)}). Please enter ${kes(cap)} or less, or type MAX.`,
        };
      }
      return { ok: true };
    },
  },
  {
    key: "notes",
    label: "Anything Else",
    type: "comments",
    required: false,
    prompt: "Is there anything else you'd like us to know? (Type SKIP if not.)",
    opts: { max: 500 },
  },
];

// ------------------------------------------------- edit consistency check
// When someone EDITs an earlier answer, later answers that depended on it can
// become invalid (a plan switch removes the CI rider, a lower cover amount
// lowers the rider caps, a new birth date changes the allowed premium
// terms...). This clears whatever no longer holds and returns the cleared
// keys so the engine re-asks exactly those questions — nothing stale ever
// reaches the sheet.
function reconcile(a, changedKey) {
  const cleared = [];
  const clear = (k) => {
    if (a[k] !== undefined) {
      delete a[k];
      cleared.push(k);
    }
  };

  if (a.coverType === "Single Life") {
    clear("spouseDob");
    clear("spouseGender");
    clear("spouseSmoker");
  }
  if (a.premiumTerm !== undefined && !termOptions(a).includes(a.premiumTerm)) clear("premiumTerm");
  if (a.plan === "Plan B") {
    clear("ciRider");
    clear("ciAmount");
  }
  if (changedKey === "calcMode") {
    clear("modalPremium");
    clear("sumAssured");
    clear("ciAmount");
    clear("accidentAmount");
  }
  if (a.modalPremium !== undefined && a.paymentFrequency && a.modalPremium < minPremiumFor(a.paymentFrequency)) {
    clear("modalPremium");
  }
  if (saMode(a)) {
    if (a.sumAssured === undefined || a.sumAssured < CI_RIDER_MIN_SA) {
      clear("ciRider");
      clear("ciAmount");
    } else if (a.ciAmount !== undefined && a.ciAmount > ciCap(a)) {
      clear("ciAmount");
    }
    if (a.sumAssured !== undefined && a.accidentAmount !== undefined && a.accidentAmount > accCap(a)) {
      clear("accidentAmount");
    }
  }
  if (!accidentEligible(a)) {
    clear("accidentRider");
    clear("accidentAmount");
  }
  if (a.ciRider === "No") clear("ciAmount");
  if (a.accidentRider === "No") clear("accidentAmount");
  return cleared;
}

// ---------------------------------------------------- derived / flags
// Everything the team needs that isn't a direct answer: ages at submission,
// annualised premium, indicative tax relief, medical/special-clearance
// flags, and "check at quote" markers for rules that can't be fully
// verified until the premium is priced. Pure function — no I/O.
function computeDerived(a, { waId, now = new Date() } = {}) {
  const today = nairobiToday(now);
  const flags = [];
  const fields = {
    status: "SUBMITTED",
    proposerWaId: waId || "",
    ageAtSubmission: ageOn(a.dateOfBirth, today),
    spouseAge: isJoint(a) && a.spouseDob ? ageOn(a.spouseDob, today) : "",
  };

  const freq = FREQUENCIES[a.paymentFrequency];
  const annual = a.modalPremium && freq ? Math.round(a.modalPremium * freq.perYear) : "";
  fields.annualisedPremium = annual;
  fields.estTaxRelief = annual === "" ? "" : Math.min(Math.round(annual * TAX_RELIEF_RATE), TAX_RELIEF_CAP);

  const sa = a.sumAssured;
  if (sa !== undefined) {
    const total = sa + (a.ciAmount || 0) + (a.accidentAmount || 0);
    if (sa > MAX_SA) {
      fields.specialClearance = "Yes";
      fields.medicalRequired = "Yes";
      flags.push(`SPECIAL_CLEARANCE: cover of ${kes(sa)} is above the ${kes(MAX_SA)} maximum`);
      flags.push(`MEDICAL_REQUIRED: cover above ${kes(MEDICAL_FREE_LIMIT)}`);
    } else if (sa > MEDICAL_FREE_LIMIT) {
      fields.specialClearance = "No";
      fields.medicalRequired = "Yes";
      flags.push(`MEDICAL_REQUIRED: cover of ${kes(sa)} is above the ${kes(MEDICAL_FREE_LIMIT)} medical-free limit`);
    } else if (total > MEDICAL_FREE_LIMIT) {
      fields.specialClearance = "No";
      fields.medicalRequired = "Check riders";
      flags.push(`MEDICAL_CHECK_RIDERS: main cover is within the medical-free limit but cover plus riders is ${kes(total)} — confirm with Prudential whether riders count`);
    } else {
      fields.specialClearance = "No";
      fields.medicalRequired = "No";
    }
    if (a.plan === "Plan B" && sa * PLAN_B_CI_PCT > PLAN_B_CI_MAX) {
      flags.push(`PLANB_CI_CAPPED: Plan B critical illness payout is capped at ${kes(PLAN_B_CI_MAX)}`);
    }
    flags.push("MIN_PREMIUM_CHECK_AT_QUOTE: cover given — confirm the priced premium meets the KES 3,000 monthly minimum");
  } else {
    fields.specialClearance = "TBC at quote";
    fields.medicalRequired = "TBC at quote";
    if (a.ciRider === "Yes" || a.accidentRider === "Yes") {
      flags.push("RIDER_CHECK_AT_QUOTE: premium-based quote with riders — split the premium and check the 50% (critical illness) and 100% (accident) caps");
    }
  }

  if (isJoint(a)) flags.push("JOINT_LIFE");

  // Age-boundary warnings: a birthday inside 30 days could change eligibility
  // between today and the date the quote is issued.
  const boundary = (who, dob) => {
    if (!dob) return;
    const age = ageOn(dob, today);
    const days = daysToNextBirthday(dob, today);
    if (days > 30) return;
    const next = age + 1;
    const reasons = [];
    if (next > MAX_AGE) reasons.push(`passes the age-${MAX_AGE} entry limit`);
    if (a.premiumTerm === "To age 60" && next > TO60_MAX_ENTRY_AGE) reasons.push(`passes the age-${TO60_MAX_ENTRY_AGE} limit for "to age 60"`);
    if (a.accidentRider === "Yes" && next > ACCIDENT_MAX_AGE) reasons.push(`passes the age-${ACCIDENT_MAX_AGE} limit for accident cover`);
    if (reasons.length) flags.push(`AGE_BOUNDARY: ${who} turns ${next} in ${days} day(s) and ${reasons.join(" and ")} — quote date may change eligibility`);
  };
  boundary("Proposer", a.dateOfBirth);
  if (isJoint(a)) boundary("Spouse", a.spouseDob);

  return { fields, flags };
}

// Client-facing notes shown on the review screen, before they submit.
function reviewNotice(a) {
  const lines = [];
  if (a.plan === "Plan B") {
    lines.push("Plan B includes critical illness cover: 50% of your cover (up to KES 15,000,000) is paid on first diagnosis, and future premiums are waived.");
  }
  lines.push("Critical illness, and death or disability caused by illness, have a 6-month waiting period from the policy start date.");
  lines.push("This policy has no surrender value.");
  if (isJoint(a)) lines.push("Joint cover pays on the first death or first diagnosis, and the policy ends when a death benefit is paid.");
  if (a.sumAssured > MAX_SA) {
    lines.push(`Cover above ${kes(MAX_SA)} needs special approval, and a medical examination. Our team will contact you.`);
  } else if (a.sumAssured > MEDICAL_FREE_LIMIT) {
    lines.push(`Cover above ${kes(MEDICAL_FREE_LIMIT)} needs a medical examination.`);
  }
  if (saMode(a)) {
    lines.push("The minimum premium is KES 3,000 a month, so very low cover amounts may be adjusted in your quote.");
  } else if (premiumMode(a)) {
    lines.push("Your cover amount will be worked out from the premium you chose.");
  }
  lines.push("The list of covered critical illnesses and your final quote will be shared with you by our team.");
  return "*Please note*\n" + lines.map((l) => `• ${l}`).join("\n");
}

// ---------------------------------------------------------------- sheet
const COLUMNS = [
  "referenceNumber",
  "submittedAt",
  "submittedAtDate",
  "sessionId",
  "status",
  "source",
  "revisionNumber",
  "revisionOf",
  "proposerWaId",
  "consentAt",
  "fullName",
  "email",
  "dateOfBirth",
  "ageAtSubmission",
  "gender",
  "smoker",
  "coverType",
  "spouseDob",
  "spouseAge",
  "spouseGender",
  "spouseSmoker",
  "plan",
  "premiumTerm",
  "calcMode",
  "paymentFrequency",
  "modalPremium",
  "annualisedPremium",
  "sumAssured",
  "ciRider",
  "ciAmount",
  "accidentRider",
  "accidentAmount",
  "estTaxRelief",
  "medicalRequired",
  "specialClearance",
  "notes",
  "flags",
  // Filled in by the team after the offline quote goes out:
  "quoteSentAt",
  "quotedBy",
];

module.exports = {
  label: "PRULife (Life Insurance)",
  publicAccess: true,
  sheetTabEnvVar: "GOOGLE_SHEET_TAB_INSURANCE",
  defaultSheetTab: "Insurance_Submissions",
  SURVEY_STEPS,
  COLUMNS,
  reconcile,
  computeDerived,
  reviewNotice,
  // exported for tests and the alert formatter
  constants: { MIN_SA, MAX_SA, MEDICAL_FREE_LIMIT, CI_RIDER_MIN_SA, MIN_MONTHLY_PREMIUM },
  helpers: { ageOn, nairobiToday, termOptions, minPremiumFor, kes, formatDob, daysToNextBirthday },
};
