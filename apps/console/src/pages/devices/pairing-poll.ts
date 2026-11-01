export interface PairingPollStatus {
  tokenRedeemed: boolean;
  shortRedeemed: boolean;
  expired: boolean;
}

/** Stop once the code is gone, both credentials are used, or the window has ended. */
export function shouldStopPairingPoll(httpStatus: number, status: PairingPollStatus | null): boolean {
  if (httpStatus === 404) return true;
  if (!status) return false;
  return status.expired || (status.tokenRedeemed && status.shortRedeemed);
}
