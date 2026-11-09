// Paramètres « state » des connexions Google en cours : aléatoires, à usage
// unique, valables quelques minutes, en nombre limité. Ils empêchent qu'un
// autre site termine une connexion Google à votre place (CSRF sur le retour
// OAuth) et qu'une accumulation de connexions abandonnées remplisse la mémoire.
import { randomBytes } from "node:crypto";

export function createStateStore({ ttlMs = 10 * 60_000, max = 50, now = () => Date.now() } = {}) {
  const states = new Map(); // state → date de création

  function purge() {
    const limit = now() - ttlMs;
    for (const [state, createdAt] of states) if (createdAt <= limit) states.delete(state);
  }

  return {
    create() {
      purge();
      // Au-delà du maximum, les plus anciennes connexions en attente sont abandonnées.
      while (states.size >= max) states.delete(states.keys().next().value);
      const state = randomBytes(32).toString("base64url");
      states.set(state, now());
      return state;
    },
    // Vrai une seule fois, et seulement si le state existe et n'a pas expiré.
    consume(state) {
      purge();
      if (typeof state !== "string" || !states.has(state)) return false;
      states.delete(state);
      return true;
    },
    get size() {
      purge();
      return states.size;
    },
  };
}
