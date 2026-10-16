import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RegistryFactKind } from '@bf/contracts';
import { describe, expect, it } from 'vitest';
import { type PlanInputs, resolvePlan, selectTemplate } from '../domain/brief/page-plan.ts';
import { loadPagePlans, pagePlans } from './page-plans.ts';

// Page-plan selection (BF-040): ≥ 40 businesses across categories, with the template they get and the pages that
// survive their facts.

type Counts = Partial<Record<RegistryFactKind, number>>;
const rich: Counts = {
  name: 1,
  phone: 1,
  email: 1,
  address: 1,
  geo: 1,
  hours: 1,
  service: 6,
  tagline: 1,
  about_summary: 1,
  team_member: 2,
};
const thin: Counts = { name: 1, phone: 1 };
const inputs = (facts: Counts, images = 4, largeImages = 2): PlanInputs => ({ facts, images, largeImages });

interface Case {
  readonly path: string | null;
  readonly facts: Counts;
  readonly images?: number;
  readonly plan: string;
  readonly pages: readonly string[];
}

const CASES: readonly Case[] = [
  {
    path: 'food_drink.cafe',
    facts: { ...rich, menu_item: 12 },
    plan: 'food_drink',
    pages: ['home', 'menu', 'about', 'contact'],
  },
  { path: 'food_drink.cafe', facts: { ...thin, service: 2 }, plan: 'food_drink', pages: ['home'] },
  {
    path: 'food_drink.restaurant.seafood_restaurant',
    facts: { ...rich, menu_item: 20 },
    plan: 'food_drink',
    pages: ['home', 'menu', 'about', 'contact'],
  },
  {
    path: 'food_drink.restaurant.pizzeria',
    facts: { ...rich, menu_item: 4 },
    plan: 'food_drink',
    pages: ['home', 'about', 'contact'],
  },
  {
    path: 'food_drink.bakery',
    facts: { ...thin, address: 1 },
    plan: 'food_drink',
    pages: ['home', 'contact'],
  },
  {
    path: 'food_drink.bars_nightlife.beach_club',
    facts: rich,
    plan: 'food_drink',
    pages: ['home', 'about', 'contact'],
  },
  {
    path: 'food_drink.private_chef',
    facts: { ...rich, menu_item: 8 },
    plan: 'food_drink',
    pages: ['home', 'menu', 'about', 'contact'],
  },
  { path: 'food_drink.ice_cream_shop', facts: thin, plan: 'food_drink', pages: ['home'] },
  {
    path: 'beauty_wellness.hair_services.hair_salon',
    facts: rich,
    plan: 'beauty_wellness',
    pages: ['home', 'services', 'about', 'contact'],
  },
  {
    path: 'beauty_wellness.hair_services.barber',
    facts: { ...thin, service: 3 },
    plan: 'beauty_wellness',
    pages: ['home'],
  },
  {
    path: 'beauty_wellness.wellness.spa',
    facts: { ...rich, booking_provider: 1 },
    plan: 'beauty_wellness',
    pages: ['home', 'services', 'about', 'contact'],
  },
  {
    path: 'beauty_wellness.beauty_services.nail_salon',
    facts: { ...thin, email: 1, service: 5 },
    plan: 'beauty_wellness',
    pages: ['home', 'services', 'contact'],
  },
  {
    path: 'beauty_wellness.tattoo_studio',
    facts: { ...rich, service: 1 },
    plan: 'beauty_wellness',
    pages: ['home', 'about', 'contact'],
  },
  {
    path: 'sports_fitness.yoga_studio',
    facts: rich,
    plan: 'beauty_wellness',
    pages: ['home', 'services', 'about', 'contact'],
  },
  { path: 'sports_fitness.gym', facts: thin, plan: 'beauty_wellness', pages: ['home'] },
  {
    path: 'retail_shopping.fashion',
    facts: rich,
    plan: 'retail',
    pages: ['home', 'products', 'about', 'contact'],
  },
  {
    path: 'retail_shopping.home_retail',
    facts: { ...thin, address: 1, service: 3 },
    plan: 'retail',
    pages: ['home', 'contact'],
  },
  {
    path: 'home_construction.construction_supplies',
    facts: rich,
    plan: 'retail',
    pages: ['home', 'products', 'about', 'contact'],
  },
  { path: 'industry_trade.wholesaler', facts: thin, plan: 'retail', pages: ['home'] },
  {
    path: 'lodging.villa_rental_agency',
    facts: { ...rich, booking_provider: 1 },
    plan: 'rentals_agencies',
    pages: ['home', 'services', 'about', 'contact'],
  },
  {
    path: 'lodging.villa_rental_agency',
    facts: { ...thin, email: 1 },
    plan: 'rentals_agencies',
    pages: ['home', 'contact'],
  },
  {
    path: 'lodging.vacation_rental',
    facts: rich,
    plan: 'rentals_agencies',
    pages: ['home', 'services', 'about', 'contact'],
  },
  {
    path: 'real_estate.real_estate_agency',
    facts: rich,
    plan: 'rentals_agencies',
    pages: ['home', 'services', 'about', 'contact'],
  },
  {
    path: 'real_estate.property_management',
    facts: { ...thin, service: 2 },
    plan: 'rentals_agencies',
    pages: ['home'],
  },
  {
    path: 'lodging.hotel',
    facts: { ...rich, amenity: 3 },
    images: 8,
    plan: 'lodging',
    pages: ['home', 'services', 'gallery', 'contact'],
  },
  {
    path: 'lodging.boutique_hotel',
    facts: rich,
    images: 3,
    plan: 'lodging',
    pages: ['home', 'services', 'contact'],
  },
  { path: 'lodging.guest_house', facts: thin, images: 0, plan: 'lodging', pages: ['home'] },
  {
    path: 'marine_nautical.boat_charter',
    facts: rich,
    plan: 'excursions_rentals',
    pages: ['home', 'services', 'about', 'contact'],
  },
  {
    path: 'marine_nautical.water_sports',
    facts: { ...thin, whatsapp: 1, service: 2 },
    plan: 'excursions_rentals',
    pages: ['home', 'contact'],
  },
  {
    path: 'tourism_leisure.travel_services',
    facts: rich,
    plan: 'excursions_rentals',
    pages: ['home', 'services', 'about', 'contact'],
  },
  {
    path: 'automotive_transport.vehicle_rental',
    facts: { ...rich, booking_provider: 1 },
    plan: 'excursions_rentals',
    pages: ['home', 'services', 'about', 'contact'],
  },
  {
    path: 'automotive_transport.passenger_transport',
    facts: thin,
    plan: 'excursions_rentals',
    pages: ['home'],
  },
  {
    path: 'automotive_transport.automotive_services',
    facts: rich,
    plan: 'trades_services',
    pages: ['home', 'services', 'about', 'contact'],
  },
  {
    path: 'automotive_transport.logistics',
    facts: rich,
    plan: 'default',
    pages: ['home', 'services', 'about', 'contact'],
  },
  {
    path: 'home_services.pool_services',
    facts: rich,
    plan: 'trades_services',
    pages: ['home', 'services', 'about', 'contact'],
  },
  {
    path: 'home_construction.finishing_trades',
    facts: { ...thin, email: 1, service: 2 },
    plan: 'trades_services',
    pages: ['home', 'contact'],
  },
  {
    path: 'professional_services.accountant',
    facts: rich,
    plan: 'trades_services',
    pages: ['home', 'services', 'about', 'contact'],
  },
  {
    path: 'health_medical.dental',
    facts: { ...rich, service: 3 },
    plan: 'trades_services',
    pages: ['home', 'about', 'contact'],
  },
  { path: 'pets_animals.veterinarian', facts: thin, plan: 'trades_services', pages: ['home'] },
  {
    path: 'education.language_school',
    facts: rich,
    plan: 'trades_services',
    pages: ['home', 'services', 'about', 'contact'],
  },
  {
    path: 'events_creative.photo_video',
    facts: rich,
    plan: 'trades_services',
    pages: ['home', 'services', 'about', 'contact'],
  },
  {
    path: 'technology_media.web_agency',
    facts: rich,
    plan: 'trades_services',
    pages: ['home', 'services', 'about', 'contact'],
  },
  {
    path: 'public_community.library',
    facts: rich,
    plan: 'default',
    pages: ['home', 'services', 'about', 'contact'],
  },
  { path: null, facts: thin, plan: 'default', pages: ['home'] },
];

describe('page plan selection', () => {
  const templates = pagePlans();

  it('covers at least 40 businesses across categories', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(40);
    expect(new Set(CASES.map((c) => c.plan))).toEqual(new Set(templates.map((t) => t.id)));
  });

  it.each(CASES.map((c, index) => [index, c] as const))(
    '#%i picks the plan and pages its facts support',
    (_i, c) => {
      const { template, matched } = selectTemplate(templates, c.path);
      expect(template.id).toBe(c.plan);
      const plan = resolvePlan(template, matched, inputs(c.facts, c.images ?? 4));
      expect(plan.pages.map((page) => page.kind)).toEqual(c.pages);
      // Every surviving block is backed: no block requiring facts the business lacks.
      for (const page of plan.pages)
        expect(page.blocks.filter((block) => block.type === 'hero')).toHaveLength(1);
    },
  );

  it('prefers the most specific prefix', () => {
    const templates = pagePlans();
    expect(selectTemplate(templates, 'home_construction.construction_supplies').template.id).toBe('retail');
    expect(selectTemplate(templates, 'home_construction.structural_work').template.id).toBe(
      'trades_services',
    );
    expect(selectTemplate(templates, 'lodging.villa_rental_agency').matched).toBe(
      'lodging.villa_rental_agency',
    );
    expect(selectTemplate(templates, 'lodging.hostel').matched).toBe('lodging');
  });

  it('folds a thin menu into the home page as a section, and a missing one into "our café"', () => {
    const food = templates.find((t) => t.id === 'food_drink');
    if (!food) throw new Error('no food plan');
    const fewItems = resolvePlan(food, 'food_drink', inputs({ ...thin, menu_item: 4 }));
    const home = fewItems.pages[0];
    expect(home?.blocks.map((b) => b.type)).toEqual(['hero', 'about', 'gallery', 'menu', 'contact']);
    expect(fewItems.collapsed).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'menu', into: 'home' })]),
    );
    const noMenu = resolvePlan(food, 'food_drink', inputs({ ...thin, service: 3 }, 0, 0));
    expect(noMenu.pages[0]?.blocks.map((b) => [b.type, b.variant])).toEqual([
      ['hero', 'centered'],
      ['highlights', 'icons'],
      ['about', 'centered'],
      ['services', 'list'],
      ['contact', 'split'],
    ]);
  });

  it('refuses malformed plan files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'page-plans-'));
    try {
      writeFileSync(
        join(dir, 'bad.yaml'),
        'id: bad\nmatch: [default]\npages:\n  - { kind: about, slug: x, blocks: [] }\n',
      );
      expect(() => loadPagePlans(dir)).toThrow(/bad.yaml is invalid/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
