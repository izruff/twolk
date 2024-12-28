/*

Implementation of the coordinator service.
- Keep track of active spaces and their members.
- Allocate resources to members trying to join a space.

In the future, it should also handle scaling the SFU workers horizontally,
managing load distribution and RTP packet transfer between two workers, and
implementing router migration policies from one worker to another.

*/

export class Coordinator {
  constructor() {
    return;
  }

  openSpace(id: number) {
    // TODO
    return;
  }

  closeSpace(id: number, validationToken?: number) {
    // TODO
    return;
  }

  addMemberToSpace(spaceId: number): { memberId: number } {
    // TODO
    return { memberId: 0 }
  }

  removeMemberFromSpace(spaceId: number, memberId: number) {
    // TODO
    return;
  }
}
