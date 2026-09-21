# Design references

The portfolio starts with Aron, his current work, and specific projects. It avoids agency slogans, invented metrics, and filler sections. An original, code-generated terrain pattern adds atmosphere without representing a fictional project.

References reviewed on September 21, 2026:

- [Lee Robinson](https://leerob.com): direct biography, readable prose, and links organized around actual work.
- [Brittany Chiang](https://brittanychiang.com): clear identity, detailed work history, and concrete project descriptions.
- [Rauno Freiberg](https://rauno.me): a short introduction with a specific role and a compact project index.
- [Maggie Appleton](https://maggieappleton.com): personal language and subject-specific organization.
- [Ian Hale](https://halei-6103.github.io/My-Portfolio/): the owner's requested reference for an atmospheric monochrome opening, clear identity, and compact navigation. Its imagery, code, and layout are not copied.

These inform composition and writing. The implementation and visual design are original.

The professional page uses scoped styling so changes cannot alter the separate workshop. Angular Material supplies interactive controls, with reduced-motion support. The workshop is loaded as a separate code chunk and has no navigation link from the professional page.

Global CSS loads through a normal stylesheet link. Angular critical-CSS inlining is disabled because its generated inline load handler conflicts with the strict script policy. No inline script exception is needed.
