import { Elysia } from "elysia";

import path from "node:path";
import fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";

import tarstream from "tar-stream";

const port = process.env.PORT || 9000;
const cwd = process.cwd();

const fileType = (s) => {
  if (s.isFile()) {
    return "file";
  } else if (s.isDirectory()) {
    return "directory";
  } else if (s.isLink()) {
    return "link";
  }
  return "unknown";
};

const fileInfo = (f, s) => {
  const name = path.basename(f);
  const type = fileType(s);
  const file = f.replace(`${cwd}/`, "");
  const {
    atime,
    atimeMs,
    birthtime,
    birthtimeMs,
    blksize,
    blocks,
    ctime,
    ctimeMs,
    dev,
    gid,
    ino,
    mode,
    mtime,
    mtimeMs,
    nlink,
    rdev,
    size,
    uid,
  } = s;
  return {
    type,
    file,
    name,
    atime,
    atimeMs,
    birthtime,
    birthtimeMs,
    blksize,
    blocks,
    ctime,
    ctimeMs,
    dev,
    gid,
    ino,
    mode,
    mtime,
    mtimeMs,
    nlink,
    rdev,
    size,
    uid,
  };
};

const codeToStatus = {
  ENOENT: 404,
};

const tar = async (f) => {
  const stat = await fs.stat(f);
  const files = [];
  if (stat.isDirectory()) {
    const dir = await fs.readdir(f, { recursive: true });
    await Promise.all(
      dir.map(async (p) => {
        files.push(p);
      })
    );
  } else {
    files.push(f);
  }
  const pack = tarstream.pack();

  await Promise.all(
    files.map(async (file) => {
      const p = path.resolve(cwd, f, file);
      const s = await fs.stat(p);
      const { size, mode, mtime, uid, gid } = s;
      const name = path.resolve(f, file).replace(`${cwd}/`, "");
      if (s.isFile()) {
        pack.entry(
          {
            type: "file",
            name,
            mode,
            mtime,
            uid,
            gid,
            //size,
          },
          await fs.readFile(p)
        );
      } else {
        pack.entry({
          type: "directory",
          name,
          mode,
          mtime,
          uid,
          gid,
          //size,
        });
      }
    })
  );

  const n = `${f}.tar.gz`;

  const write = createWriteStream(n);
  pack /*.pipe(createGzip())*/
    .pipe(write);

  return n;
};

const untar = async (f, t) => {
  const stat = await fs.stat(f);
  const extract = tarstream.extract();
  createReadStream(f).pipe(extract);

  for await (const entry of extract) {
    const target = path.resolve(cwd, t, entry.header.name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    if (entry.header.type === "file") {
      entry.pipe(createWriteStream(target));
    } else {
      await fs.mkdir(target, { recursive: true });
    }
    await Promise.all([
      fs.chmod(target, entry.header.mode),
      fs.chown(target, entry.header.uid, entry.header.gid),
      fs.utimes(target, new Date(), entry.header.mtime),
    ]);
  }
};

const app = new Elysia()
  .onError(({ code, error }) => {
    const status = codeToStatus[code] || 500;
    return new Response(null, { status });
  })
  .get("/*", async ({ params, request }) => {
    const f = path.resolve(cwd, params["*"]);
    const stat = await fs.stat(f);
    if (!stat.isDirectory()) {
      const accept = request.headers.get("accept");
      if (accept === "application/octet-stream") {
        return new Response(Bun.file(f));
      }
      const file = fileInfo(f, stat);
      return { success: true, file };
    }
    const dir = await fs.readdir(f);
    return {
      success: true,
      files: await Promise.all(
        dir.map(async (p) => {
          const d = path.resolve(f, p);
          return fileInfo(d, await fs.stat(d));
        })
      ),
    };
  })
  .delete("/*", async ({ params }) => {
    const f = path.resolve(cwd, params["*"]);
    await fs.unlink(f);
    return new Response(null, { status: 204 });
  })

  .put("/*", async ({ params, request }) => {
    const f = path.resolve(cwd, params["*"]);
    await fs.writeFile(f, await request.arrayBuffer());
    return new Response(null, { status: 204 });
  })
  .post("/compress", async ({ params, body, query }) => {
    const f = path.resolve(cwd, body.file);
    const format = body.format;
    if (format === "tar.gz") {
      const n = await tar(f);
      return new Response(null, {
        status: 204,
        headers: { location: n },
      });
    } else {
      return new Response(null, { status: 400 });
    }
  })
  .post("/decompress", async ({ params, body, query }) => {
    const f = path.resolve(cwd, body.file);
    const t = body.target || "/";
    const format = body.format;

    if (format === "tar.gz") {
      await untar(f, t);
      return new Response(null, {
        status: 204,
      });
    } else {
      return new Response(null, { status: 400 });
    }
  })
  .post("/decompress", async ({ body }) => {
    const f = path.resolve(cwd, body.file);
    const t = body.target || "/";
    const format = body.format;

    if (format === "tar.gz") {
      await untar(f, t);
      return new Response(null, {
        status: 204,
      });
    } else {
      return new Response(null, { status: 400 });
    }
  })
  .post("/rename", async ({ body }) => {
    const dir = body.dir || "/";

    const file = path.resolve(cwd, dir, body.file);
    const target = path.resolve(cwd, dir, body.target);

    await fs.rename(file, target);
  })
  .post("/copy", async ({ body }) => {
    const dir = body.dir || "/";

    const file = path.resolve(cwd, dir, body.file);
    const target = path.resolve(cwd, dir, body.target);

    await fs.copyFile(file, target);
  })
  .post("/*", async ({ params }) => {
    const f = path.resolve(cwd, params["*"]);
    await fs.mkdir(f, { recursive: true });
    return new Response(null, { status: 204 });
  });

app.listen(port);

console.log(`Listening on port ${port}`);
