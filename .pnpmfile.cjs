module.exports = {
  hooks: {
    readPackage(pkg) {
      // Remove re2 from any dependency sections to prevent installation
      if (pkg.dependencies && pkg.dependencies.re2) {
        delete pkg.dependencies.re2;
      }
      if (pkg.optionalDependencies && pkg.optionalDependencies.re2) {
        delete pkg.optionalDependencies.re2;
      }
      if (pkg.peerDependencies && pkg.peerDependencies.re2) {
        delete pkg.peerDependencies.re2;
      }
      return pkg;
    },
  },
};
