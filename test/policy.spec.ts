import { campaignsOf, loadConfig } from '../src/config.js';
import { maskPhone, toCall } from '../src/dialer.js';
import { hinglishText } from '../src/likho.js';
import { judge } from '../src/policy.js';

describe('the policy and the call details', () => {
  const call = toCall({
    crt_object_id: 'd000-0a1b2c3d-vce-0001',
    call_id: '123',
    call_time: '2026-10-03 09:12:00',
    campaign: 'Inbound Sales',
    agent: 'agent-12',
    disposition: 'sale',
    talk_seconds: 95,
    phone: '+91 98765 43210',
    lead_source: 'tv',
    nothing: null,
  })!;

  it('reads a row of the contract, keeping unknown columns as extras', () => {
    expect(call).toMatchObject({
      crtObjectId: 'd000-0a1b2c3d-vce-0001',
      callId: '123',
      callTime: '2026-10-03 09:12:00',
      campaign: 'Inbound Sales',
      talkSeconds: 95,
      extra: { lead_source: 'tv' },
    });
    expect(toCall({ call_id: '1' })).toBeNull();
  });

  it('masks a phone number to its last digits', () => {
    expect(maskPhone('+91 98765 43210', 4)).toBe('…3210');
    expect(maskPhone('+91 98765 43210', 0)).toBe('');
    expect(maskPhone('', 4)).toBe('');
  });

  it('judges a call by campaign and talk time', () => {
    expect(judge(call, { campaigns: [], minTalkSeconds: 20 })).toEqual({ take: true });
    expect(judge(call, { campaigns: ['inbound sales'], minTalkSeconds: 20 })).toEqual({ take: true });
    expect(judge(call, { campaigns: ['Other'], minTalkSeconds: 20 })).toMatchObject({
      take: false,
      reason: /campaign/,
    });
    expect(judge(call, { campaigns: [], minTalkSeconds: 120 })).toMatchObject({
      take: false,
      reason: /talk time/,
    });
  });

  it('reads the settings, with the company’s values left to the .local files', () => {
    const config = loadConfig({ LIKHO_ENV: 'test', CAMPAIGNS: ' a, b ,,c ' }, 'D:/nowhere');
    expect(config.SOURCE).toBe('ameyo');
    expect(config.SCHEDULE_ENABLED).toBe(false);
    expect(campaignsOf(config)).toEqual(['a', 'b', 'c']);
    expect(() => loadConfig({ LIKHO_ENV: 'staging' }, 'D:/nowhere')).toThrow(/LIKHO_API_KEY/);
    expect(() => loadConfig({ LIKHO_ENV: 'test', SCHEDULE_ENABLED: 'true' }, 'D:/nowhere')).toThrow(
      /DIALER_DATABASE_URL/,
    );
  });

  it('writes the Hinglish layer as one text', () => {
    expect(
      hinglishText([
        { index: 0, startSeconds: 0, endSeconds: 1, textScript: 'नमस्ते', textRoman: 'namaste' },
        { index: 1, startSeconds: 1, endSeconds: 2, textScript: '', textRoman: '  ' },
        { index: 2, startSeconds: 2, endSeconds: 3, textScript: 'धन्यवाद', textRoman: 'dhanyavaad' },
      ]),
    ).toBe('namaste\ndhanyavaad');
  });
});
