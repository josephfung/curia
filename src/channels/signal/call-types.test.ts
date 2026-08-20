import { describe, expect, it } from 'vitest';
import { parseSignalCallEvent, quoteCallIds, serializeCallParams } from './call-types.js';

describe('quoteCallIds', () => {
  it('quotes a callId larger than MAX_SAFE_INTEGER so JSON.parse cannot corrupt it', () => {
    const line = '{"method":"callEvent","params":{"result":{"callId":-7828393543136742976,"state":"RINGING_INCOMING"}}}';
    const quoted = quoteCallIds(line);
    const parsed = JSON.parse(quoted) as { params: { result: { callId: string } } };
    expect(parsed.params.result.callId).toBe('-7828393543136742976');
  });

  it('leaves lines without callId untouched', () => {
    const line = '{"method":"receive","params":{"envelope":{"timestamp":1755700000000}}}';
    expect(quoteCallIds(line)).toBe(line);
  });

  it('quotes positive callIds too', () => {
    const quoted = quoteCallIds('{"callId":10618350530572808640}');
    expect(JSON.parse(quoted)).toEqual({ callId: '10618350530572808640' });
  });

  it('does not touch an already-quoted callId', () => {
    const line = '{"callId":"123"}';
    expect(quoteCallIds(line)).toBe(line);
  });
});

describe('parseSignalCallEvent', () => {
  it('parses a full RINGING_INCOMING event with bigint callId', () => {
    const ev = parseSignalCallEvent({
      callId: '-7828393543136742976',
      state: 'RINGING_INCOMING',
      number: '+15196161377',
      uuid: '93d5da7e-b744-4189-9f99-463fe46c7f71',
      isOutgoing: false,
      inputDeviceName: 'signal_input_10618350530572808640',
      outputDeviceName: 'signal_output_10618350530572808640',
    });
    expect(ev).not.toBeNull();
    expect(ev!.callId).toBe(-7828393543136742976n);
    expect(ev!.state).toBe('RINGING_INCOMING');
    expect(ev!.number).toBe('+15196161377');
    expect(ev!.inputDeviceName).toBe('signal_input_10618350530572808640');
    expect(ev!.reason).toBeNull();
  });

  it('parses ENDED with reason and null device names absent', () => {
    const ev = parseSignalCallEvent({ callId: '5', state: 'ENDED', isOutgoing: false, reason: 'RemoteHangup' });
    expect(ev!.state).toBe('ENDED');
    expect(ev!.reason).toBe('RemoteHangup');
    expect(ev!.number).toBeNull();
  });

  it('returns null for an unknown state or missing callId', () => {
    expect(parseSignalCallEvent({ callId: '5', state: 'DIALING', isOutgoing: false })).toBeNull();
    expect(parseSignalCallEvent({ state: 'ENDED', isOutgoing: false })).toBeNull();
  });
});

describe('serializeCallParams', () => {
  it('emits callId as a bare JSON number literal beyond MAX_SAFE_INTEGER', () => {
    expect(serializeCallParams('+12264448150', -7828393543136742976n)).toBe(
      '{"account":"+12264448150","callId":-7828393543136742976}',
    );
  });
});
