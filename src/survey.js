// DEPRECATED: survey question sets now live under ./surveys/ (one file per
// track — gt.js, mt.js, insurance.js — resolved via ./surveys/index.js).
// This file is kept only so any code still doing `require("./survey")`
// keeps working, pointed at the GT track for backward compatibility.
// New code should `require("./surveys")` and use getSurveyStepsForTrack(track).
module.exports = require("./surveys/gt");
