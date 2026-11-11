CREATE TABLE IF NOT EXISTS shows (
    id integer PRIMARY KEY CHECK (id = 7),
    capacity integer NOT NULL CHECK (capacity = 100)
);

INSERT INTO shows (id, capacity) VALUES (7, 100)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS users (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username varchar(64) NOT NULL UNIQUE,
    password_hash text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orders (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id integer NOT NULL REFERENCES users(id),
    show_id integer NOT NULL REFERENCES shows(id),
    status text NOT NULL DEFAULT 'NO_CARRINHO'
        CHECK (status IN ('NO_CARRINHO', 'RESERVADO', 'CANCELADO')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS orders_reserved_show_user_idx
ON orders (show_id, user_id) WHERE status = 'RESERVADO';

CREATE INDEX IF NOT EXISTS orders_user_id_idx ON orders (user_id, id DESC);
