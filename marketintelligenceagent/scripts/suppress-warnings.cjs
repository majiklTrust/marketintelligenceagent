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

'use strict';

const originalEmitWarning = process.emitWarning;

process.emitWarning = function (warning, ...args) {
  if (typeof warning === 'string' && warning.includes('punycode')) return;
  if (warning?.name === 'DeprecationWarning' && warning?.message?.includes('punycode')) return;
  return originalEmitWarning.call(process, warning, ...args);
};
