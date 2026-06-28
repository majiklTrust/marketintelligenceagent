/**
#
# Copyright (c) 2026 majiklTrust Market Intelligence, LLC. All rights reserved.
#
# This file is part of Market Intelligence and contains proprietary and
# confidential information. Unauthorized copying, modification, distribution,
# or use of this file, via any medium, is strictly prohibited without the
# express written permission of the copyright holder.
#

**/

export const PRE_PUB_STATUSES = ["draft", "pending_approval", "scheduled"];

const PRE_PUB = new Set(PRE_PUB_STATUSES);


export function isPrePublication(status) {
  return PRE_PUB.has(status);
}





export function canTransition(from, to) {
  return PRE_PUB.has(from) && PRE_PUB.has(to);
}







const EDITABLE = new Set(["draft", "pending_approval", "scheduled", "failed", "blocked"]);

export function isEditable(status) {
  return EDITABLE.has(status);
}
