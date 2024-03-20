import path from "node:path";
import fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { Elysia, t } from "elysia";
import tarstream from "tar-stream";
import { createGunzip, createGzip } from "node:zlib";
import unzipper from "unzip-stream";
import Packer from "zip-stream";

/**
 * Default port for the server
 * @type {number}
 */
const port = process.env.PORT || 9000;

/**
 * Current working directory
 * @type {string}
 */
const cwd = process.cwd();

/**
 * Detects the type of file system object
 * @param {fs.Stats} s - The file system object
 * @returns {string} - The type of the file system object
 */
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

/**
 * Creates file info object from file path and file system stats
 * @param {string} f - The file path
 * @param {fs.Stats} s - The file system stats
 * @returns {object} - The file info object
 */
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
  NOT_FOUND: 404,
  VALIDATION: 400,
  PARSE: 400,
  UNKNOWN: 500,
  INTERNAL_SERVER_ERROR: 500,
};

/**
 * Gets files in a directory or a single file
 * @param {string} f - The file or directory path
 * @returns {Promise<Array<{p: string, s: fs.Stats}>>} - Array of file objects containing path and stats
 */
const getFiles = async (f) => {
  const stat = await fs.stat(f);
  if (stat.isDirectory()) {
    const dir = await fs.readdir(f, { withFileTypes: true });
    return Promise.all(
      dir.map(async (file) => {
        const p = path.resolve(f, file.name);
        const s = await fs.stat(p);
        return { p, s };
      })
    );
  } else {
    return [{ p: f, s: stat }];
  }
};

/**
 * Extracts a tar archive
 * @param {string} f - The path to the tar file
 * @param {string} t - The target directory for extraction
 * @returns {Promise<void>}
 */
const untar = async (f, t) => {
  const extract = tarstream.extract();
  createReadStream(f).pipe(extract);

  for await (const entry of extract) {
    const target = path.resolve(t, entry.header.name);
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

/**
 * Extracts a zip archive
 * @param {string} f - The path to the zip file
 * @param {string} t - The target directory for extraction
 * @returns {Promise<void>}
 */
const unzip = async (f, t) => {
  const extract = unzipper.Extract({ path: t });
  createReadStream(f).pipe(extract);
};

/**
 * Creates a zip archive
 * @param {string} f - The file or directory path to be archived
 * @returns {Promise<string>} - The path to the created zip file
 */
const zip = async (f) => {
  const files = await getFiles(f);
  const archive = new Packer();

  await Promise.all(
    files.map(async (file) => {
      const { p, s } = file;
      const { mode, mtime, uid, gid } = s;
      const name = path.resolve(f, p).replace(`${cwd}/`, "");
      if (s.isFile()) {
        archive.entry(await fs.readFile(p), {
          type: "file",
          name,
          mode,
          mtime,
          uid,
          gid,
        });
      } else {
        archive.entry(null, {
          type: "directory",
          name,
          mode,
          mtime,
          uid,
          gid,
        });
      }
    })
  );

  archive.finish();

  const n = `${f}.zip`;
  const write = createWriteStream(n);

  archive.pipe(write);

  return n;
};

/**
 * Creates a tar archive
 * @param {string} f - The file or directory path to be archived
 * @returns {Promise<string>} - The path to the created tar file
 */
const tar = async (f) => {
  const files = await getFiles(f);
  const pack = tarstream.pack();

  await Promise.all(
    files.map(async (file) => {
      const { p, s } = file;
      const { mode, mtime, uid, gid } = s;
      const name = path.resolve(f, p).replace(`${cwd}/`, "");
      if (s.isFile()) {
        pack.entry(
          {
            type: "file",
            name,
            mode,
            mtime,
            uid,
            gid,
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
        });
      }
    })
  );

  const n = `${f}.tar.gz`;
  const write = createWriteStream(n);
  pack.pipe(write);

  return n;
};

// Error handler
const onError = ({ code, error }) => {
  let response = null;
  const status = codeToStatus[code] || 500;
  if (status !== 404) {
    console.log("[error]", error);
  }
  if (code === "VALIDATION") {
    return error.toResponse();
  } else {
    return new Response(response, { status });
  }
};

// File compression handler
const compressHandler = async ({ body }) => {
  const dir = body.dir || "/";
  const target = path.resolve(cwd, `./${dir}`, `./${body.target}`);
  const format = body.format;
  if (format === "tar.gz") {
    const n = await tar(target);
    return new Response(null, {
      status: 204,
      headers: { location: n },
    });
  } else if (format === "zip") {
    const n = await zip(target);
    return new Response(null, {
      status: 204,
      headers: { location: n },
    });
  } else {
    return new Response(null, { status: 400 });
  }
};

const compressHandlerValidatior = {
  body: t.Object({
    dir: t.String(),
    target: t.String(),
    format: t.Union([t.Literal("tar.gz"), t.Literal("zip")]),
  }),
};

// File decompression handler
const decompressHandler = async ({ body }) => {
  const dir = body.dir || "/";
  const file = path.resolve(cwd, `./${dir}`, `./${body.file}`);
  const target = path.resolve(cwd, `./${body.target}`);
  const format = body.format;
  if (format === "tar.gz") {
    await untar(file, target);
    return new Response(null, { status: 204 });
  } else if (format === "zip") {
    await unzip(file, target);
    return new Response(null, { status: 204 });
  } else {
    return new Response(null, { status: 400 });
  }
};

const decompressHandlerValidatior = {
  body: t.Object({
    dir: t.String(),
    file: t.String(),
    target: t.String(),
    format: t.Union([t.Literal("tar.gz"), t.Literal("zip")]),
  }),
};

// File renaming handler
const renameHandler = async ({ body }) => {
  const dir = body.dir || "/";
  const file = path.resolve(cwd, `./${dir}`, body.file);
  const target = path.resolve(cwd, `./${dir}`, body.target);
  await fs.rename(file, target);
  return new Response(null, {
    status: 204,
    headers: { location: target.replace(cwd, "") },
  });
};

const renameHandlerValidator = {
  body: t.Object({
    dir: t.String(),
    file: t.String(),
    target: t.String(),
  }),
};

// File copying handler
const copyHandler = async ({ body }) => {
  const dir = body.dir || "/";
  const file = path.resolve(cwd, `./${dir}`, `./${body.file}`);
  const target = path.resolve(cwd, `./${dir}`, `./${body.target}`);
  await fs.copyFile(file, target);
  return new Response(null, {
    status: 204,
    headers: { location: target.replace(cwd, "") },
  });
};

const copyHandlerValidator = {
  body: t.Object({
    dir: t.String(),
    file: t.String(),
    target: t.String(),
  }),
};

// File mode handler
const modeHandler = async ({ body }) => {
  const dir = body.dir || "/";
  const file = path.resolve(cwd, `./${dir}`, `./${body.file}`);
  const mode = body.mode;
  await fs.chmod(file, mode);
  return new Response(null, { status: 204 });
};

const modeHandlerValidator = {
  body: t.Object({
    dir: t.String(),
    file: t.String(),
    mode: t.Number(),
  }),
};

// Directory creation handler
const createDirectoryHandler = async ({ body }) => {
  const dir = body.dir || "/";
  const target = path.resolve(cwd, `./${dir}`);
  await fs.mkdir(target, { recursive: true });
  return new Response(null, {
    status: 204,
    headers: { location: target.replace(cwd, "") },
  });
};

const createDirectoryHandlerValidator = {
  body: t.Object({
    dir: t.String(),
  }),
};

const getFileHandler = async ({ params, request }) => {
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
};

const getFileHandlerValidator = {
  params: t.Object(
    {
      ["*"]: t.String(),
    },
    { description: "Filename to get as path parameter" }
  ),
};

const deleteFileHandler = async ({ params }) => {
  const f = path.resolve(cwd, params["*"]);
  await fs.unlink(f);
  return new Response(null, { status: 204 });
};

const deleteFileHandlerValidator = {
  params: t.Object(
    {
      ["*"]: t.String(),
    },
    { description: "Filename to delete as path parameter" }
  ),
};

const createFileHandler = async ({ params, request }) => {
  const f = path.resolve(cwd, params["*"]);
  await fs.mkdir(path.dirname(f), { recursive: true });
  await fs.writeFile(f, await request.arrayBuffer());
  return new Response(null, { status: 204 });
};

const createFileHandlerValidator = {
  params: t.Object(
    {
      ["*"]: t.String(),
    },
    { description: "Filename to create as path parameter" }
  ),
};

// Routes definition
const app = new Elysia()
  .onError(onError)
  .post("/compress", compressHandler, compressHandlerValidatior)
  .post("/decompress", decompressHandler, decompressHandlerValidatior)
  .post("/rename", renameHandler, renameHandlerValidator)
  .post("/copy", copyHandler, copyHandlerValidator)
  .post("/mode", modeHandler, modeHandlerValidator)
  .post("/create", createDirectoryHandler, createDirectoryHandlerValidator)
  .get("/*", getFileHandler, getFileHandlerValidator)
  .delete("/*", deleteFileHandler, deleteFileHandlerValidator)
  .put("/*", createFileHandler, createFileHandlerValidator);

app.listen(port);

console.log(`Listening on port ${port}`);
