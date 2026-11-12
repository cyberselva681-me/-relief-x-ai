// Sample data. The incident feed stands in for the Urban Early Warning System output,
// and the suppliers are fictional. Both are labelled as sample data in the UI and README.

export const ITEMS = {
  water_pack: { name: 'Drinking water pack (6 x 1L)' },
  food_kit: { name: 'Dry food kit (1 family, 2 days)' },
  first_aid_kit: { name: 'First-aid kit' },
  blanket: { name: 'Emergency blanket' }
};

export const INCIDENTS = [
  {
    id: 'inc-bellandur',
    area: 'Bellandur',
    lat: 12.9304,
    lng: 77.6784,
    type: 'Flash flood',
    rainfall24hMm: 142,
    waterLevelCm: 60,
    reports: 34,
    notes:
      'Lake overflow onto service roads. Ground-floor flooding in apartment complexes. Two underpasses closed. Elderly residents reported stranded.',
    source: 'Early Warning feed (sample)'
  },
  {
    id: 'inc-hebbal',
    area: 'Hebbal',
    lat: 13.0358,
    lng: 77.597,
    type: 'Urban flooding',
    rainfall24hMm: 96,
    waterLevelCm: 35,
    reports: 18,
    notes: 'Waterlogging near the flyover and low-lying lanes. Power cuts reported in two wards.',
    source: 'Early Warning feed (sample)'
  },
  {
    id: 'inc-silkboard',
    area: 'Silk Board',
    lat: 12.9177,
    lng: 77.6233,
    type: 'Road waterlogging',
    rainfall24hMm: 71,
    waterLevelCm: 20,
    reports: 9,
    notes: 'Junction waterlogged, heavy traffic disruption. Few households directly affected.',
    source: 'Early Warning feed (sample)'
  }
];

export const SUPPLIERS = [
  {
    id: 'sup-cityrelief',
    name: 'CityRelief Wholesale',
    area: 'Whitefield',
    lat: 12.9698,
    lng: 77.75,
    rating: 4.6,
    prices: { water_pack: 2.6, food_kit: 6.4, first_aid_kit: 9.5, blanket: 5.2 },
    stock: { water_pack: 2000, food_kit: 1500, first_aid_kit: 300, blanket: 1000 }
  },
  {
    id: 'sup-namma',
    name: 'Namma Essentials Depot',
    area: 'Jayanagar',
    lat: 12.925,
    lng: 77.5938,
    rating: 4.3,
    prices: { water_pack: 2.3, food_kit: 5.8, first_aid_kit: 8.9, blanket: 4.8 },
    stock: { water_pack: 400, food_kit: 300, first_aid_kit: 40, blanket: 200 }
  },
  {
    id: 'sup-medplus',
    name: 'MedPlus Emergency Supply',
    area: 'Indiranagar',
    lat: 12.9719,
    lng: 77.6412,
    rating: 4.8,
    prices: { water_pack: 3.0, food_kit: 7.0, first_aid_kit: 8.2, blanket: 5.9 },
    stock: { water_pack: 1200, food_kit: 900, first_aid_kit: 500, blanket: 600 }
  },
  {
    id: 'sup-hosur',
    name: 'Hosur Road Traders',
    area: 'Electronic City',
    lat: 12.8452,
    lng: 77.6602,
    rating: 4.0,
    prices: { water_pack: 2.1, food_kit: 5.5, first_aid_kit: 8.5, blanket: 4.5 },
    stock: { water_pack: 100, food_kit: 80, first_aid_kit: 10, blanket: 50 }
  }
];
