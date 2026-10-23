// Commerce pack: products, categories and brands that agree with each other. One persona slot
// ("category") picks a category; the product noun, the SKU prefix and the price band all come from
// it, so "Trail Running Shoes" is in Footwear at a footwear price. Brands are invented; any
// resemblance to a real trademark is coincidental. FROZEN at 1.0.0.

const freeze = (o) => {
  if (o !== null && typeof o === "object") for (const v of Object.values(o)) freeze(v);
  return Object.freeze(o);
};

// [category, SKU prefix, min price, max price, nouns]
const commerceCategories = [
  ["Home & Kitchen", "HOM", 6, 180, ["Kettle", "Cutting Board", "Casserole Dish", "Tea Towel Set", "Storage Jar", "Mixing Bowl", "Table Lamp", "Throw Blanket"]],
  ["Outdoors", "OUT", 15, 320, ["Daypack", "Camp Stove", "Sleeping Bag", "Headlamp", "Trekking Poles", "Water Bottle", "Hammock", "Rain Shell"]],
  ["Electronics", "ELE", 12, 650, ["Bluetooth Speaker", "Desk Fan", "Power Bank", "Webcam", "Mechanical Keyboard", "Wireless Mouse", "Phone Stand", "USB Hub"]],
  ["Apparel", "APP", 10, 140, ["Cotton T-Shirt", "Wool Sweater", "Canvas Jacket", "Denim Shorts", "Linen Shirt", "Knit Scarf", "Fleece Vest", "Rain Poncho"]],
  ["Footwear", "FTW", 25, 220, ["Trail Running Shoes", "Leather Boots", "Canvas Sneakers", "Slip-On Loafers", "Hiking Sandals", "Wool Slippers", "Rain Boots", "Court Shoes"]],
  ["Toys & Games", "TOY", 5, 90, ["Wooden Puzzle", "Card Game", "Building Blocks", "Board Game", "Kite", "Plush Bear", "Marble Run", "Dice Set"]],
  ["Books & Stationery", "BKS", 3, 45, ["Hardcover Notebook", "Fountain Pen", "Sketchbook", "Desk Calendar", "Sticky Notes", "Pencil Set", "Atlas", "Cookbook"]],
  ["Beauty & Personal Care", "BEA", 4, 85, ["Hand Cream", "Bath Salts", "Shaving Brush", "Lip Balm", "Face Mask", "Hair Brush", "Body Lotion", "Soap Bar"]],
  ["Pet Supplies", "PET", 4, 110, ["Dog Leash", "Cat Tree", "Chew Toy", "Pet Bowl", "Travel Carrier", "Grooming Brush", "Bird Feeder", "Fish Tank Filter"]],
  ["Garden", "GAR", 5, 260, ["Watering Can", "Pruning Shears", "Raised Planter", "Seed Starter Kit", "Garden Gloves", "Compost Bin", "Trellis", "Hose Reel"]],
  ["Sports & Fitness", "SPT", 8, 300, ["Yoga Mat", "Resistance Bands", "Jump Rope", "Foam Roller", "Dumbbell Pair", "Tennis Racket", "Water Flask", "Gym Bag"]],
  ["Office", "OFF", 6, 420, ["Standing Desk", "Desk Organizer", "Monitor Arm", "Task Chair", "Label Maker", "Paper Shredder", "Whiteboard", "Cable Tray"]],
];

const commerceBrands = [
  "Quillon", "Brambleton", "Tidewell", "Ferngrove", "Oakhaven", "Kestrelle", "Marrowby", "Lumenfield", "Harrowgate", "Pennywick",
  "Alderbrook", "Stonecroft", "Wrenfield", "Cinderlane", "Moorhaven", "Fallowmere", "Birchwell", "Thistledown", "Larkspur & Vale", "Copperfield Co",
  "Northmere", "Ashgrove", "Tamsin & Rowe", "Halcyon Street", "Briarwood Supply", "Gullwing", "Saltmarsh", "Redfern Goods", "Ember & Oak", "Kingfisher Row",
  "Windermoor", "Hollowell", "Sparrowhill", "Cloverdale Works", "Ironbridge Trading", "Maplecrest", "Dunmore & Finch", "Rushlight", "Elmstead", "Foxtail Provisions",
];

const commerceAdjectives = [
  "Classic", "Everyday", "Compact", "Heritage", "Travel", "Studio", "Field", "Weekend", "Signature", "Essential",
  "Artisan", "Lightweight", "Heavy-Duty", "Pocket", "Family-Size", "Limited", "Natural", "Recycled", "Foldable", "Insulated",
];

const ENDING = [[0, 3], [1, 4], [2, 2], [3, 3]];

export const commerce = freeze({
  name: "commerce",
  version: 1,
  vocab: { commerceCategories, commerceBrands, commerceAdjectives },
  types: { "commerce.price": "Float" },
  rules({ tokens, first, last, kind }) {
    if (last === "category" || last === "department") return { sdl: "String", gen: "commerce.category" };
    if (last === "brand" || last === "manufacturer") return { sdl: "String", gen: "commerce.brand" };
    if (last === "sku") return { sdl: "String", gen: "commerce.sku" };
    if (last === "price" && tokens.length === 1) return { sdl: "Float", gen: "commerce.price" };
    if (kind === "product" && (last === "name" || last === "title") && tokens.length === 1) return { sdl: "String", gen: "commerce.product" };
    if (tokens.join(" ") === "product name") return { sdl: "String", gen: "commerce.product" };
    return null;
  },
  generators(V) {
    const rows = V.commerceCategories.map(([name, sku, min, max, nouns]) => ({ name, sku, min, max, nouns }));
    const row = (ctx) => ctx.slot("category").pick(rows);
    return {
      "commerce.category": (ctx) => row(ctx).name,
      "commerce.brand": (ctx) => ctx.slot("brand").pick(V.commerceBrands),
      "commerce.product": (ctx) => {
        const r = row(ctx);
        return `${ctx.slot("brand").pick(V.commerceBrands)} ${ctx.slot("adj").pick(V.commerceAdjectives)} ${ctx.slot("noun").pick(r.nouns)}`;
      },
      "commerce.sku": (ctx) => {
        const s = ctx.slot("skuNum");
        return `${row(ctx).sku}-${String(s.int(0, 99999)).padStart(5, "0")}`;
      },
      // whole cents inside the category's price band, with the same weighted endings as `money`
      "commerce.price": ({ stream: s, args, slot }) => {
        const r = slot("category").pick(rows);
        const min = args.min ?? r.min;
        const max = args.max ?? r.max;
        const dollars = s.int(Math.ceil(min), Math.floor(max));
        const e = s.weighted(ENDING);
        const cents = e === 0 ? 0 : e === 1 ? 99 : e === 2 ? 49 : s.int(0, 99);
        return Math.min(max * 100, Math.max(min * 100, dollars * 100 + cents)) / 100;
      },
    };
  },
});

export default commerce;
