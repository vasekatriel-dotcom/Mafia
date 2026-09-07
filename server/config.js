// server/config.js
// Central place to tweak game rules without touching logic files.

module.exports = {
  MAX_PLAYERS: 20,

  // Default role distribution. MAFIA_COUNT + DOCTOR + NARRATOR + villagers = MAX_PLAYERS.
  // Detective is NOT part of this initial pool -- it is carved out of the
  // Villager pool later, at the moment remaining villagers hits DETECTIVE_TRIGGER_COUNT.
  ROLES: {
    MAFIA_COUNT: 4,
    DOCTOR_COUNT: 1,
    NARRATOR_COUNT: 1
    // VILLAGER_COUNT is derived: MAX_PLAYERS - MAFIA_COUNT - DOCTOR_COUNT - NARRATOR_COUNT
  },

  // Villager (non-mafia, non-doctor/narrator/detective-already-used) headcount that
  // triggers a random Detective promotion from the remaining Villagers.
  DETECTIVE_TRIGGER_COUNT: 6,

  // Timers, in seconds.
  TIMERS: {
    VOTING_SECONDS: 60,
    NIGHT_SECONDS: 45,
    PUZZLE_SECONDS: 30
  },

  // Puzzle (mini-game) config.
  PUZZLE: {
    QUESTION_COUNT: 10,
    REQUIRED_CORRECT: 10, // out of QUESTION_COUNT -- 10/10 by default, configurable
    EARLY_ROUNDS_ELIGIBLE: [1, 2], // only players eliminated in round 1 or 2 get a puzzle shot
    SINGLE_ATTEMPT_PER_ELIMINATION: true,
    OPERAND_MAX: 12 // small integers for +,-,*,/ questions
  },

  // Optional Redis persistence flag. When false, everything lives in memory
  // and resets on server restart. Wiring Redis is left as a documented
  // extension point (see README "Production notes").
  USE_REDIS: false,

  SESSION: {
    TOKEN_BYTES: 24 // secret code entropy
  }
};
