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

import fs from "fs";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const current = pkg.config.cssversion;
const [major, minor] = current.split(".").map(Number);

pkg.config.cssversion = `${major+1}.${minor}`;

fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2));
console.log("New cssversion:", pkg.config.cssversion);
