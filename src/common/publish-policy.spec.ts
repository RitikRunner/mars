import { calculatePublishableStock } from './publish-policy';
import { Channel } from './enums';

describe('Velocity-Based Publish Policy', () => {
  it('should publish 0 when available stock is 0', () => {
    const qty = calculatePublishableStock({
      channel: Channel.WEBSITE,
      sku: 'MRS-LIP-104',
      available: 0,
      velocityPerMin: 10,
    });
    expect(qty).toBe(0);
  });

  it('should allow website to sell down to the last unit (blind window = 0)', () => {
    const qty = calculatePublishableStock({
      channel: Channel.WEBSITE,
      sku: 'MRS-LIP-104',
      available: 1,
      velocityPerMin: 30, // Even high velocity
    });
    expect(qty).toBe(1);
  });

  it('should cut off Flipkart when stock is below the threshold', () => {
    // Hero SKU selling 30/min = 0.5/sec
    // Flipkart blind window = 180s
    // raw threshold = ceil(0.5 * 180 * 1.5) = 135 units
    const stockAt130 = calculatePublishableStock({
      channel: Channel.FLIPKART,
      sku: 'MRS-LIP-104',
      available: 130,
      velocityPerMin: 30,
      buffer: 2,
    });
    expect(stockAt130).toBe(0); // Cut off!

    const stockAt200 = calculatePublishableStock({
      channel: Channel.FLIPKART,
      sku: 'MRS-LIP-104',
      available: 200,
      velocityPerMin: 30,
      buffer: 2,
    });
    expect(stockAt200).toBe(198); // 200 - buffer 2
  });

  it('should enforce channel floor for slow selling SKUs', () => {
    // Velocity = 0
    // Flipkart floor is 5
    const stockAt4 = calculatePublishableStock({
      channel: Channel.FLIPKART,
      sku: 'MRS-KJL-011',
      available: 4,
      velocityPerMin: 0,
    });
    expect(stockAt4).toBe(0);

    const stockAt10 = calculatePublishableStock({
      channel: Channel.FLIPKART,
      sku: 'MRS-KJL-011',
      available: 10,
      velocityPerMin: 0,
      buffer: 2,
    });
    expect(stockAt10).toBe(8);
  });
});
