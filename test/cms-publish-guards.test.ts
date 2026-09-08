// Dvě brány, které chyběly, a obě se projevovaly stejně: v editoru je všechno v pořádku,
// na webu není nic.
//
//  1. `required` na poli STRÁNKY se nevynucovalo nikde. Každý zápis draftu posílá
//     `requireRequired: false` (a je to tak správně — do rozdělaného draftu se nedá uložit,
//     kdyby chtěl mít vyplněno všechno), jenže publikace nevalidovala vůbec. `ValidateOpts`
//     přitom od začátku slibuje „required is only mandatory when publishing". Důsledek
//     v nasazení, které to našlo: akce bez data, publikovaná, s živou stránkou — a neviditelná
//     ve všech výpisech, protože front-end akci bez data nemá kam na kalendáři položit.
//
//  2. Slug, který si obsluhuje sám front-end. Headless CMS o cizí routovací tabulce neví,
//     takže stránku na `/kalendar` klidně publikuje. Stránka hlásí `published`, URL vrací 200
//     a servíruje něco úplně jiného — a z editoru to nejde poznat, protože z jeho strany je
//     všechno správně.

import { describe, expect, test } from "bun:test";
import { assertPublishable, createCmsHandlers } from "../packages/cms/src/index";
import type { HandlerContext } from "@pramen/server";

type Row = Record<string, unknown>;
type Query = { from: string; where?: Record<string, unknown>; limit?: number };

/** Db, která umí jen to, co tyhle dvě brány potřebují: přečíst typ obsahu. Obě se ozvou
 * dřív, než se sáhne na cokoli dalšího — což je samo o sobě součást tvrzení. */
const dbWith = (types: Row[]) =>
  ({
    find: async (q: Query) => types.filter((t) => Object.entries(q.where ?? {}).every(([k, v]) => t[k] === v)),
    exec: async () => {
      throw new Error("nemělo se sem vůbec dojít");
    },
    insert: async () => {
      throw new Error("nemělo se sem vůbec dojít");
    },
    update: async () => {
      throw new Error("nemělo se sem vůbec dojít");
    },
  }) as never;

const AKCE = {
  id: "t1",
  slug: "akce",
  fieldsSchema: [
    { name: "startsAt", label: "Začátek", type: "date", required: true },
    { name: "endsAt", label: "Konec", type: "date" },
    { name: "perex", label: "Perex", type: "textarea" },
  ],
};

describe("publikovat jde jen stránku, která splní vlastní schéma", () => {
  const page = (fields: Row) => ({ id: "p1", typeId: "t1", title: "Akce", slug: "akce-x", fields });

  test("chybějící povinné pole publikaci zastaví a NAZVE ho", async () => {
    // Hláška musí nést POPISKU, ne klíč: člověk, který ji čte, se dívá na formulář, a ten
    // pole „startsAt" nikde tak nepojmenoval.
    const err = await assertPublishable(dbWith([AKCE]), page({ perex: "něco" })).catch((e: Error) => e);
    expect((err as Error).message).toContain("Začátek");
    expect((err as Error).message).not.toContain("startsAt");
  });

  test("prázdný řetězec je totéž co nevyplněno", async () => {
    // Editor ukládá nevyplněné textové pole jako "", ne jako chybějící klíč — kdyby brána
    // hlídala jen `undefined`, propustila by přesně ten stav, který v praxi vzniká.
    await expect(assertPublishable(dbWith([AKCE]), page({ startsAt: "" }))).rejects.toThrow(/Začátek/);
    await expect(assertPublishable(dbWith([AKCE]), page({ startsAt: null }))).rejects.toThrow(/Začátek/);
    await expect(assertPublishable(dbWith([AKCE]), page({}))).rejects.toThrow(/Začátek/);
  });

  test("vyplněné povinné pole projde a nepovinná se neřeší", async () => {
    await expect(assertPublishable(dbWith([AKCE]), page({ startsAt: "2026-06-06" }))).resolves.toBeUndefined();
  });

  test("víc chybějících polí se vyjmenuje najednou", async () => {
    // Po jednom by to bylo tolik kol publikace, kolik je prázdných polí.
    const dva = { ...AKCE, fieldsSchema: [...AKCE.fieldsSchema, { name: "sport", label: "Sport", type: "text", required: true }] };
    const err = (await assertPublishable(dbWith([dva]), page({})).catch((e: Error) => e)) as Error;
    expect(err.message).toContain("Začátek");
    expect(err.message).toContain("Sport");
  });

  test("pole bez popisky se nazve aspoň klíčem", async () => {
    const bezLabel = { ...AKCE, fieldsSchema: [{ name: "startsAt", type: "date", required: true }] };
    await expect(assertPublishable(dbWith([bezLabel]), page({}))).rejects.toThrow(/startsAt/);
  });

  test("typ bez povinných polí publikaci nebrzdí", async () => {
    const volny = { ...AKCE, fieldsSchema: [{ name: "perex", label: "Perex", type: "textarea" }] };
    await expect(assertPublishable(dbWith([volny]), page({}))).resolves.toBeUndefined();
  });

  test("stránka, jejíž typ obsahu už neexistuje, se publikovat DÁ", async () => {
    // Schéma není, takže není proti čemu měřit — a odmítnout publikaci by tu stránku uvěznilo
    // ve stavu, ze kterého ji nemá co dostat ven.
    await expect(assertPublishable(dbWith([]), page({}))).resolves.toBeUndefined();
  });
});

describe("slug, který si obsluhuje front-end, se nedá obsadit", () => {
  const handlers = createCmsHandlers({ reservedSlugs: ["kalendar", "Sportoviste", " mapa "] });
  const create = (slug: string, opts = handlers) =>
    (opts.createPage as unknown as { run: (c: HandlerContext, i: Row) => Promise<unknown> }).run(
      { db: dbWith([{ id: "t1", slug: "page", fieldsSchema: [] }]) } as never,
      { typeId: "t1", title: "T", slug },
    );

  test("rezervovaný slug se odmítne, a hláška řekne PROČ", async () => {
    // „slug už existuje" by bylo lživé — žádná stránka tam není. Problém je, že tam nikdy
    // nebude vidět.
    const err = (await create("kalendar").catch((e: Error) => e)) as Error;
    expect(err.message).toContain("kalendar");
    expect(err.message).toMatch(/never be reachable/);
  });

  test("porovnává se bez ohledu na velikost písmen a okolní mezery", async () => {
    // Seznam píše člověk, do slugu se dostane cokoli. Kdyby se porovnávalo přesně, stačil by
    // překlep v konfiguraci a brána by mlčela.
    await expect(create("sportoviste")).rejects.toThrow(/never be reachable/);
    await expect(create("mapa")).rejects.toThrow(/never be reachable/);
    await expect(create("KALENDAR")).rejects.toThrow(/never be reachable/);
  });

  test("volný slug projde branou dál", async () => {
    // Dojde až na `assertSlugFree`, kterou tahle stub-db neumí — a přesně to je důkaz, že
    // rezervace nezastavila něco, co zastavit neměla.
    await expect(create("o-nas")).rejects.toThrow(/nemělo se sem vůbec dojít/);
  });

  test("bez konfigurace se nerezervuje nic", async () => {
    // Výchozí chování se nesmí změnit: CMS routovací tabulku front-endu nezná a hádat ji
    // nesmí — seznam, který je z 90 % správně, odmítá slugy, které jsou volné.
    const bez = createCmsHandlers();
    await expect(create("kalendar", bez)).rejects.toThrow(/nemělo se sem vůbec dojít/);
  });
});
