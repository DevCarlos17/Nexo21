import {
  requierePinEmisionNc,
  puedeElegirDepositoExplicito,
  resolverDepositoOverride,
} from "../notas-credito-pin-gating";

// Correccion obs #2835: este modulo de gating YA NO se consume desde el
// modal Tradicional (crear-ncr-modal.tsx) — la regla PIN definitiva dice que
// esa pantalla nunca pide PIN. Estas funciones puras quedan reservadas para
// el entry point POS (Slice 5a-2), donde el PIN transaccional SI aplica por
// falta de permiso. Las pruebas siguen validando la logica pura, generica
// para cualquier caller que la reuse.

// ─── requierePinEmisionNc ────────────────────────────────────────
// Spec notas-credito-pos "Modelo de doble PIN": el permiso `ventas.nota_credito`
// decide el PIN de EMISION — con permiso no se pide PIN, sin permiso se exige
// el PIN de supervisor (obs #2802 decision 3).

describe("requierePinEmisionNc (PIN A — emision, permiso decide)", () => {
  it("usuario CON permiso ventas.nota_credito: no exige PIN", () => {
    expect(requierePinEmisionNc(true)).toBe(false);
  });

  it("usuario SIN permiso ventas.nota_credito: exige PIN de supervisor", () => {
    expect(requierePinEmisionNc(false)).toBe(true);
  });
});

// ─── puedeElegirDepositoExplicito ────────────────────────────────
// Spec notas-credito-pos "Modelo de doble PIN": el SEGUNDO PIN (independiente
// del de emision) desbloquea el selector de deposito explicito; sin el, el
// selector permanece bloqueado (riel automatico).

describe("puedeElegirDepositoExplicito (PIN B — override de deposito, SIEMPRE independiente del PIN A)", () => {
  it("segundo PIN autorizado: desbloquea el selector explicito", () => {
    expect(puedeElegirDepositoExplicito(true)).toBe(true);
  });

  it("sin segundo PIN: selector permanece bloqueado (riel automatico)", () => {
    expect(puedeElegirDepositoExplicito(false)).toBe(false);
  });
});

// ─── resolverDepositoOverride ────────────────────────────────────
// Bridge puro hacia el futuro parametro `depositoReingresoId` (Design
// §Interfaces) que Slice 5a-2 threadea dentro de la tx de `crearNotaCredito`
// (obs #2831 — NO se threadea en 5a). `null` significa "sin override, el
// backend sigue el riel automatico"; un id concreto significa "el usuario
// eligio explicitamente este deposito, con el segundo PIN ya autorizado".

describe("resolverDepositoOverride (bridge puro hacia el futuro depositoReingresoId)", () => {
  it("sin PIN B autorizado: siempre null, sin importar si hay algo elegido en el selector", () => {
    expect(
      resolverDepositoOverride({
        pinOverrideAutorizado: false,
        depositoElegidoId: "dep-1",
      }),
    ).toBeNull();
  });

  it("con PIN B autorizado pero sin eleccion todavia: null (sigue el riel hasta que el usuario elija)", () => {
    expect(
      resolverDepositoOverride({
        pinOverrideAutorizado: true,
        depositoElegidoId: null,
      }),
    ).toBeNull();
  });

  it("con PIN B autorizado y deposito elegido: retorna el id elegido", () => {
    expect(
      resolverDepositoOverride({
        pinOverrideAutorizado: true,
        depositoElegidoId: "dep-1",
      }),
    ).toBe("dep-1");
  });
});
